import { UseCase } from "../../../../shared/core/UseCase";
import { IAnnotationRepository } from "../repositories/IAnnotationRepository";
import { Result, ok, err } from "../../../../shared/core/Result";
import { AppError } from "../../../../shared/core/AppError";
import { Annotation } from "../../domain/aggregates/Annotation";
import { AnnotationsFromTemplate } from "../../domain/aggregates/AnnotationsFromTemplate";
import {
  CuratorId,
  URI,
  AnnotationFieldId,
  AnnotationNote,
  AnnotationTemplateId,
  PublishedRecordId,
} from "../../domain/value-objects";
import { UniqueEntityID } from "../../../../shared/domain/UniqueEntityID";
import { UseCaseError } from "../../../../shared/core/UseCaseError";
import {
  AnnotationValueFactory,
  AnnotationValueInput,
} from "../../domain/AnnotationValueFactory";
import { IAnnotationTemplateRepository } from "../repositories/IAnnotationTemplateRepository";
import { IAnnotationFieldRepository } from "../repositories/IAnnotationFieldRepository";
import { IAnnotationsFromTemplatePublisher } from "../ports/IAnnotationsFromTemplatePublisher";

// Define specific errors
export namespace CreateAndPublishAnnotationsFromTemplateErrors {
  export class TemplateNotFound extends UseCaseError {
    constructor(templateId: string) {
      super(`Template with ID ${templateId} not found`);
    }
  }

  export class AnnotationCreationFailed extends UseCaseError {
    constructor(message: string) {
      super(`Failed to create annotations: ${message}`);
    }
  }

  export class AnnotationPublishFailed extends UseCaseError {
    constructor(id: string, message: string) {
      super(`Failed to publish annotation ${id}: ${message}`);
    }
  }

  export class AnnotationSaveFailed extends UseCaseError {
    constructor(id: string, message: string) {
      super(`Failed to save annotation ${id}: ${message}`);
    }
  }
}

// Single annotation input for a template
export interface AnnotationInput {
  annotationFieldId: string;
  type: string;
  value: AnnotationValueInput;
  note?: string;
}

export interface CreateAndPublishAnnotationsFromTemplateDTO {
  curatorId: string;
  url: string;
  templateId: string;
  annotations: AnnotationInput[];
}

export type CreateAndPublishAnnotationsFromTemplateResponse = Result<
  { annotationIds: string[] },
  | CreateAndPublishAnnotationsFromTemplateErrors.TemplateNotFound
  | CreateAndPublishAnnotationsFromTemplateErrors.AnnotationCreationFailed
  | CreateAndPublishAnnotationsFromTemplateErrors.AnnotationPublishFailed
  | CreateAndPublishAnnotationsFromTemplateErrors.AnnotationSaveFailed
  | AppError.UnexpectedError
>;

export class CreateAndPublishAnnotationsFromTemplateUseCase
  implements
    UseCase<
      CreateAndPublishAnnotationsFromTemplateDTO,
      Promise<CreateAndPublishAnnotationsFromTemplateResponse>
    >
{
  constructor(
    private readonly annotationRepository: IAnnotationRepository,
    private readonly annotationTemplateRepository: IAnnotationTemplateRepository,
    private readonly annotationFieldRepository: IAnnotationFieldRepository,
    private readonly annotationsFromTemplatePublisher: IAnnotationsFromTemplatePublisher
  ) {}

  async execute(
    request: CreateAndPublishAnnotationsFromTemplateDTO
  ): Promise<CreateAndPublishAnnotationsFromTemplateResponse> {
    try {
      // Create common value objects
      const curatorIdOrError = CuratorId.create(request.curatorId);
      const urlOrError = URI.create(request.url);
      const templateIdOrError = AnnotationTemplateId.create(
        new UniqueEntityID(request.templateId)
      );

      if (
        curatorIdOrError.isErr() ||
        urlOrError.isErr() ||
        templateIdOrError.isErr()
      ) {
        return err(
          new CreateAndPublishAnnotationsFromTemplateErrors.AnnotationCreationFailed(
            "Invalid common properties"
          )
        );
      }

      const curatorId = curatorIdOrError.value;
      const url = urlOrError.value;
      const templateId = templateIdOrError.value;

      // Fetch the template
      const template =
        await this.annotationTemplateRepository.findById(templateId);
      if (!template) {
        return err(
          new CreateAndPublishAnnotationsFromTemplateErrors.TemplateNotFound(
            templateId.getValue().toString()
          )
        );
      }

      // Create annotations from inputs
      const annotations: Annotation[] = [];

      for (const annotationInput of request.annotations) {
        // Get the field ID
        const fieldIdOrError = AnnotationFieldId.create(
          new UniqueEntityID(annotationInput.annotationFieldId)
        );

        if (fieldIdOrError.isErr()) {
          return err(
            new CreateAndPublishAnnotationsFromTemplateErrors.AnnotationCreationFailed(
              "Invalid annotation field ID"
            )
          );
        }

        // Fetch the actual field from the repository
        const annotationField = await this.annotationFieldRepository.findById(
          fieldIdOrError.value
        );
        if (!annotationField) {
          return err(
            new CreateAndPublishAnnotationsFromTemplateErrors.AnnotationCreationFailed(
              `Annotation field with ID ${annotationInput.annotationFieldId} not found`
            )
          );
        }

        // Verify the field type matches the input type
        if (annotationField.definition.type.value !== annotationInput.type) {
          return err(
            new CreateAndPublishAnnotationsFromTemplateErrors.AnnotationCreationFailed(
              `Type mismatch: Field expects ${annotationField.definition.type.value} but got ${annotationInput.type}`
            )
          );
        }

        const note = annotationInput.note
          ? AnnotationNote.create(annotationInput.note)
          : undefined;

        // Create annotation value using the field's type
        const valueOrError = AnnotationValueFactory.create({
          type: annotationField.definition.type,
          valueInput: annotationInput.value,
        });

        if (valueOrError.isErr()) {
          return err(
            new CreateAndPublishAnnotationsFromTemplateErrors.AnnotationCreationFailed(
              `Invalid annotation value: ${valueOrError.error.message}`
            )
          );
        }

        // Create annotation with template ID and the full annotation field
        const annotationOrError = Annotation.create({
          curatorId,
          url,
          annotationField,
          value: valueOrError.value,
          note: note,
          annotationTemplateIds: [templateId],
        });

        if (annotationOrError.isErr()) {
          return err(
            new CreateAndPublishAnnotationsFromTemplateErrors.AnnotationCreationFailed(
              annotationOrError.error.message || "Failed to create annotation"
            )
          );
        }

        annotations.push(annotationOrError.value);
      }

      // Create AnnotationsFromTemplate aggregate to enforce invariants
      const annotationsFromTemplateResult = AnnotationsFromTemplate.create({
        annotations,
        template,
        curatorId,
        createdAt: new Date(),
      });

      if (annotationsFromTemplateResult.isErr()) {
        return err(
          new CreateAndPublishAnnotationsFromTemplateErrors.AnnotationCreationFailed(
            annotationsFromTemplateResult.error ||
              "Annotations do not satisfy template requirements"
          )
        );
      }

      // Get the AnnotationsFromTemplate instance
      const annotationsFromTemplate = annotationsFromTemplateResult.value;

      // Publish all annotations at once using the template publisher
      const publishResult = await this.annotationsFromTemplatePublisher.publish(
        annotationsFromTemplate
      );

      if (publishResult.isErr()) {
        return err(
          new CreateAndPublishAnnotationsFromTemplateErrors.AnnotationPublishFailed(
            "batch",
            publishResult.error.message
          )
        );
      }

      // Get the published record IDs
      const publishedRecordIds = publishResult.value;

      // Mark all annotations as published in one operation
      const markPublishedResult =
        annotationsFromTemplate.markAllAnnotationsAsPublished(
          publishedRecordIds
        );

      if (markPublishedResult.isErr()) {
        return err(
          new CreateAndPublishAnnotationsFromTemplateErrors.AnnotationPublishFailed(
            "batch",
            markPublishedResult.error
          )
        );
      }

      // Create a list of published annotation IDs for the response
      const publishedAnnotationIds: string[] = [];
      for (const annotation of annotationsFromTemplate.annotations) {
        publishedAnnotationIds.push(annotation.annotationId.getStringValue());
      }

      // Save all annotations
      try {
        for (const annotation of annotationsFromTemplate.annotations) {
          await this.annotationRepository.save(annotation);
        }
      } catch (error: any) {
        return err(
          new CreateAndPublishAnnotationsFromTemplateErrors.AnnotationSaveFailed(
            "batch",
            error.message
          )
        );
      }

      return ok({ annotationIds: publishedAnnotationIds });
    } catch (error: any) {
      return err(new AppError.UnexpectedError(error));
    }
  }
}
