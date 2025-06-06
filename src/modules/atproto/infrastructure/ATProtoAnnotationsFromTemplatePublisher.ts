import { $Typed, AtpAgent } from "@atproto/api";
import {
  IAnnotationsFromTemplatePublisher,
  PublishedAnnotationsFromTemplateResult,
} from "src/modules/annotations/application/ports/IAnnotationsFromTemplatePublisher";
import { AnnotationsFromTemplate } from "src/modules/annotations/domain/aggregates/AnnotationsFromTemplate";
import { PublishedRecordId } from "src/modules/annotations/domain/value-objects";
import { Result, ok, err } from "src/shared/core/Result";
import { UseCaseError } from "src/shared/core/UseCaseError";
import { AnnotationsFromTemplateMapper } from "./AnnotationsFromTemplateMapper";
import { StrongRef } from "../domain";
import { Delete } from "@atproto/sync";

export class ATProtoAnnotationsFromTemplatePublisher
  implements IAnnotationsFromTemplatePublisher
{
  private agent: AtpAgent;
  private readonly COLLECTION = "app.annos.annotation";

  constructor(agent: AtpAgent) {
    this.agent = agent;
  }

  /**
   * Publishes multiple annotations from a template to the AT Protocol in a single transaction
   */
  async publish(
    annotationsFromTemplate: AnnotationsFromTemplate
  ): Promise<Result<PublishedAnnotationsFromTemplateResult, UseCaseError>> {
    try {
      const annotations = annotationsFromTemplate.annotations;
      const curatorDid = annotations[0]?.curatorId.value;

      if (!curatorDid) {
        return err(new Error("No curator DID found in annotations"));
      }

      // Use the mapper to generate create operations and rkeys
      const writes = AnnotationsFromTemplateMapper.toCreateOperations(
        annotationsFromTemplate,
        this.COLLECTION
      );

      // Apply all writes in a single transaction
      const result = await this.agent.com.atproto.repo.applyWrites({
        repo: curatorDid,
        writes,
        validate: false,
      });

      // Create a map of annotation IDs to published record IDs
      const publishedRecordIds = new Map<string, PublishedRecordId>();

      // Extract the results from the response
      const createResults = result.data.results || [];

      // Map each annotation to its corresponding result
      for (let i = 0; i < annotations.length; i++) {
        const annotation = annotations[i];
        const annotationId = annotation!.annotationId.getStringValue();
        const createResult = createResults[i];

        if (
          !createResult ||
          createResult.$type !== "com.atproto.repo.applyWrites#createResult"
        ) {
          return err(
            new Error(`No create result found for annotation ${annotationId}`)
          );
        }

        // Get the URI and CID from the result
        const { uri, cid } = createResult;

        // Create the PublishedRecordId
        const publishedRecordId = PublishedRecordId.create({
          uri,
          cid,
        });

        // Add to the map using the annotation ID as the key
        publishedRecordIds.set(annotationId, publishedRecordId);
      }

      return ok(publishedRecordIds);
    } catch (error) {
      console.error("Error publishing annotations:", error);
      return err(
        new Error(error instanceof Error ? error.message : String(error))
      );
    }
  }

  /**
   * Unpublishes (deletes) multiple Annotation records from the AT Protocol
   */
  async unpublish(
    recordIds: PublishedRecordId[]
  ): Promise<Result<void, UseCaseError>> {
    try {
      // Group records by repo (curator DID)
      const recordsByRepo = new Map<string, { rkey: string; uri: string }[]>();

      for (const recordId of recordIds) {
        const publishedRecordId = recordId.getValue();
        const strongRef = new StrongRef(publishedRecordId);
        const atUri = strongRef.atUri;
        const repo = atUri.did.toString();
        const rkey = atUri.rkey;

        if (!recordsByRepo.has(repo)) {
          recordsByRepo.set(repo, []);
        }

        recordsByRepo.get(repo)?.push({ rkey, uri: publishedRecordId.uri });
      }

      // For each repo, create a batch delete operation
      for (const [repo, records] of recordsByRepo.entries()) {
        const writes = records.map(
          (record) =>
            ({
              $type: "com.atproto.repo.applyWrites#delete",
              collection: this.COLLECTION,
              rkey: record.rkey,
            }) as $Typed<Delete>
        );

        // Apply all deletes for this repo in a single transaction
        await this.agent.com.atproto.repo.applyWrites({
          repo,
          writes: writes as any,
          validate: false,
        });
      }

      return ok(undefined);
    } catch (error) {
      return err(
        new Error(error instanceof Error ? error.message : String(error))
      );
    }
  }
}
