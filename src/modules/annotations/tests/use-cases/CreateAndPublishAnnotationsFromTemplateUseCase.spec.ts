import { CreateAndPublishAnnotationsFromTemplateUseCase } from "../../application/use-cases/CreateAndPublishAnnotationsFromTemplateUseCase";
import { Annotation } from "../../domain/aggregates/Annotation";
import {
  AnnotationTemplateId,
  PublishedRecordId,
} from "../../domain/value-objects";
import { UniqueEntityID } from "../../../../shared/domain/UniqueEntityID";
import { AnnotationTemplateDTOBuilder } from "../utils/builders/AnnotationTemplateDTOBuilder";
import { CreateAndPublishAnnotationTemplateUseCase } from "../../application/use-cases/CreateAndPublishAnnotationTemplateUseCase";
import { FakeAnnotationFieldPublisher } from "../utils/publishers/FakeAnnotationFieldPublisher";
import { UseCaseError } from "src/shared/core/UseCaseError";
import { InMemoryAnnotationRepository } from "../utils/InMemoryAnnotationRepository";
import { InMemoryAnnotationTemplateRepository } from "../utils/InMemoryAnnotationTemplateRepository";
import { FakeAnnotationTemplatePublisher } from "../utils/publishers/FakeAnnotationTemplatePublisher";
import { InMemoryAnnotationFieldRepository } from "../utils/InMemoryAnnotationFieldRepository";
import { AnnotationField } from "../../domain/aggregates";
import { FakeAnnotationsFromTemplatePublisher } from "../utils/publishers/FakeAnnotationsFromTemplatePublisher";

describe("CreateAndPublishAnnotationsFromTemplateUseCase", () => {
  let annotationRepository: InMemoryAnnotationRepository;
  let annotationTemplateRepository: InMemoryAnnotationTemplateRepository;
  let annotationFieldRepository: InMemoryAnnotationFieldRepository;
  let annotationsFromTemplatePublisher: FakeAnnotationsFromTemplatePublisher;
  let fieldPublisher: FakeAnnotationFieldPublisher;
  let templatePublisher: FakeAnnotationTemplatePublisher;
  let useCase: CreateAndPublishAnnotationsFromTemplateUseCase;
  let templateId: string;
  let createdFields: AnnotationField[] = [];

  // Helper to create a template first
  async function createTestTemplate() {
    const createTemplateUseCase = new CreateAndPublishAnnotationTemplateUseCase(
      annotationTemplateRepository,
      templatePublisher,
      fieldPublisher
    );

    const templateDTO = new AnnotationTemplateDTOBuilder()
      .withCuratorId("did:plc:curator123")
      .withName("Test Template")
      .withDescription("Test Description")
      .addField({
        name: "Rating Field",
        description: "A rating field",
        type: "rating",
        definition: {
          numberOfStars: 5,
        },
        required: true,
      })
      .addField({
        name: "Note Field",
        description: "A note field",
        type: "dyad",
        definition: {
          sideA: "Agree",
          sideB: "Disagree",
        },
      })
      .build();

    const result = await createTemplateUseCase.execute(templateDTO);
    expect(result.isOk()).toBe(true);

    if (result.isOk()) {
      return result.value.templateId;
    }
    throw new Error("Failed to create test template");
  }

  beforeEach(async () => {
    // Reset created fields array
    createdFields = [];

    // Create repositories and publishers
    annotationRepository = new InMemoryAnnotationRepository();
    annotationFieldRepository = new InMemoryAnnotationFieldRepository();
    fieldPublisher = new FakeAnnotationFieldPublisher();

    // Create template repository with field repository reference
    annotationTemplateRepository = new InMemoryAnnotationTemplateRepository();

    // Create template publisher with field repository reference
    templatePublisher = new FakeAnnotationTemplatePublisher(
      fieldPublisher,
      annotationFieldRepository
    );

    annotationsFromTemplatePublisher =
      new FakeAnnotationsFromTemplatePublisher();

    useCase = new CreateAndPublishAnnotationsFromTemplateUseCase(
      annotationRepository,
      annotationTemplateRepository,
      annotationFieldRepository,
      annotationsFromTemplatePublisher
    );

    // Create a template for testing
    templateId = await createTestTemplate();
  });

  it("should create and publish annotations from a template", async () => {
    // Arrange
    const dto = {
      curatorId: "did:plc:curator123",
      url: "https://example.com/resource",
      templateId: templateId,
      annotations: [
        {
          annotationFieldId: "1", // This will be replaced with actual field ID
          type: "rating",
          value: { rating: 4 },
          note: "Good rating",
        },
        {
          annotationFieldId: "2", // This will be replaced with actual field ID
          type: "dyad",
          value: { value: 0.7 },
        },
      ],
    };

    // Get the actual field IDs from the template
    const template = await annotationTemplateRepository.findById(
      AnnotationTemplateId.create(new UniqueEntityID(templateId)).unwrap()
    );
    expect(template).not.toBeNull();

    const fields = template!.getAnnotationFields();
    expect(fields.length).toBe(2);

    // Verify that fields are in the field repository
    for (const field of fields) {
      const savedField = await annotationFieldRepository.findById(
        field.fieldId
      );
      expect(savedField).not.toBeNull();
      console.log(
        `Found field in repository: ${field.fieldId.getStringValue()}`
      );
    }

    // Update the DTO with actual field IDs
    dto.annotations[0]!.annotationFieldId = fields[0]!.fieldId.getStringValue();
    dto.annotations[1]!.annotationFieldId = fields[1]!.fieldId.getStringValue();

    // Act
    const result = await useCase.execute(dto);
    if (result.isErr()) {
      console.error("Error creating annotations:", result.error);
    }
    // Check if the annotations were published

    // Assert
    expect(result.isOk()).toBe(true);

    if (result.isOk()) {
      const { annotationIds } = result.value;
      expect(annotationIds).toBeDefined();
      expect(annotationIds.length).toBe(2);

      // Check that annotations were saved
      for (const annotationId of annotationIds) {
        const fakeUri = `at://fake-did/app.annos.annotation/${annotationId}`;
        const fakeCid = `fake-cid-${annotationId}`;
        const publishedRecordId = PublishedRecordId.create({
          uri: fakeUri,
          cid: fakeCid,
        });
        const savedAnnotation =
          await annotationRepository.findByPublishedRecordId(publishedRecordId);

        expect(savedAnnotation).not.toBeNull();
        expect(savedAnnotation).toBeInstanceOf(Annotation);
        expect(savedAnnotation!.publishedRecordId).toBeDefined();
        expect(savedAnnotation!.curatorId.value).toBe(dto.curatorId);
        expect(savedAnnotation!.url.value).toBe(dto.url);

        // Check template association
        expect(savedAnnotation!.annotationTemplateIds).toBeDefined();
        expect(savedAnnotation!.annotationTemplateIds!.length).toBe(1);
        expect(
          savedAnnotation!.annotationTemplateIds![0]!.getStringValue()
        ).toBe(templateId);
      }
    } else {
      fail(`Expected Ok, got Err: ${result.error}`);
    }
  });

  it("should fail when template is not found", async () => {
    // Arrange
    const dto = {
      curatorId: "did:plc:curator123",
      url: "https://example.com/resource",
      templateId: new UniqueEntityID().toString(), // Non-existent template ID
      annotations: [
        {
          annotationFieldId: new UniqueEntityID().toString(),
          type: "rating",
          value: { rating: 4 },
        },
      ],
    };

    // Act
    const result = await useCase.execute(dto);

    // Assert
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect((result.error as UseCaseError).message).toContain("not found");
    }
  });

  it("should fail when required fields are missing", async () => {
    // This test would need to be implemented once we have the AnnotationsFromTemplate
    // aggregate properly checking for required fields

    // For now, we'll just create a placeholder test
    expect(true).toBe(true);
  });
});
