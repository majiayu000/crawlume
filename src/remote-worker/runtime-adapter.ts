import { normalizeError, ReadError } from "../errors.js";
import type { ControlPlaneJobRequest } from "../control-plane/job-input.js";
import type {
  JobBudget,
  JobDataClass,
  JobPlacementClass,
} from "../control-plane/project-scope.js";
import type {
  PageReadArtifact,
  ReadPageOptions,
  ReadPageResult,
} from "../types.js";

export type RemoteWorkerRuntimeJob = ControlPlaneJobRequest & Readonly<{
  id: string;
  data_class: JobDataClass;
  placement: Readonly<{ class: JobPlacementClass }>;
  budget: Readonly<{
    deadline_ms: JobBudget["deadlineMs"];
    max_provider_attempts: JobBudget["maxProviderAttempts"];
    max_document_bytes: JobBudget["maxDocumentBytes"];
    max_browser_ms: JobBudget["maxBrowserMs"];
    max_browser_contexts: JobBudget["maxBrowserContexts"];
  }>;
}>;

export type PublicReadRuntimeReader = Readonly<{
  readPageArtifact(
    options: ReadPageOptions & Readonly<{ signal: AbortSignal }>,
  ): Promise<PageReadArtifact>;
}>;

export class PublicReadRuntimeAdapter {
  constructor(private readonly reader: PublicReadRuntimeReader) {}

  async execute(job: RemoteWorkerRuntimeJob, signal: AbortSignal): Promise<ReadPageResult> {
    if (job.type !== "read") {
      throw new ReadError(
        "INVALID_ARGUMENT",
        "The public-read Runtime Adapter only supports read Jobs.",
        { details: { jobType: job.type } },
      );
    }
    if (job.data_class !== "public") {
      throw new ReadError(
        "INVALID_ARGUMENT",
        "The public-read Runtime Adapter only accepts public data.",
        { details: { dataClass: job.data_class } },
      );
    }
    if (job.placement.class !== "public") {
      throw new ReadError(
        "INVALID_ARGUMENT",
        "The public-read Runtime Adapter only accepts public placement.",
        { details: { placementClass: job.placement.class } },
      );
    }

    try {
      const artifact = await this.reader.readPageArtifact({
        url: job.input.url,
        ...(job.input.browserAllowed === undefined
          ? {}
          : { browserAllowed: job.input.browserAllowed }),
        ...(job.input.cacheMode === undefined ? {} : { cacheMode: job.input.cacheMode }),
        ...(job.input.maxAgeSeconds === undefined
          ? {}
          : { maxAgeSeconds: job.input.maxAgeSeconds }),
        ...(job.input.browserReadiness === undefined
          ? {}
          : { browserReadiness: job.input.browserReadiness }),
        requestId: job.id,
        budget: {
          deadlineMs: job.budget.deadline_ms,
          maxAttempts: job.budget.max_provider_attempts,
          maxDocumentBytes: job.budget.max_document_bytes,
          maxBrowserMs: job.budget.max_browser_ms,
          maxBrowserContexts: job.budget.max_browser_contexts,
          maxOptionalModelTokens: 0,
        },
        signal,
      });
      const { discoveredLinks: _discoveredLinks, ...result } = artifact;
      return result;
    } catch (error) {
      throw normalizeError(error);
    }
  }
}
