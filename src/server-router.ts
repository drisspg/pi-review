import type { IncomingMessage, ServerResponse } from "node:http";

import { inputFromBody, MalformedJsonError, readBody, recordFromBody, sendJson } from "./http.js";
import type { AskStreamResponse } from "./ask-stream-api.js";
import type { CommentApi } from "./comment-api.js";
import type { DraftReviewApi } from "./draft-review-api.js";
import type { FileApi } from "./file-api.js";
import type { PiApi } from "./pi-api.js";
import type { PrApi } from "./pr-api.js";
import type { ReviewMemoryApi } from "./review-memory-api.js";
import type { ReviewPromptApi } from "./review-prompt-api.js";
import type { ReviewSubmitRouteApi } from "./review-submit-route-api.js";
import type { SavedAnalysisApi } from "./saved-analysis-api.js";
import type { ShellApi } from "./shell-api.js";

export type ServerLogger = {
  entries: () => unknown[];
  error: (scope: string, message: string, data?: Record<string, unknown>) => void;
  info: (scope: string, message: string, data?: Record<string, unknown>) => void;
};

export type ServerRouteDeps = {
  askStreamApi: { stream: (res: AskStreamResponse, payload: Record<string, unknown>) => Promise<void> };
  commentApi: CommentApi;
  draftReviewApi: DraftReviewApi;
  fileApi: FileApi;
  gpuWorkspaceCreateResponse: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  gpuWorkspaceDeleteResponse: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  gpuWorkspaceExecResponse: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  gpuWorkspaceStatusResponse: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
  logger: ServerLogger;
  piApi: PiApi;
  prApi: PrApi;
  reviewMemoryApi: ReviewMemoryApi;
  reviewPromptApi: ReviewPromptApi;
  reviewSubmitRouteApi: ReviewSubmitRouteApi;
  savedAnalysisApi: SavedAnalysisApi;
  sendStatic: (res: ServerResponse, pathname: string, head?: boolean) => Promise<void>;
  shellApi: ShellApi;
};

export type ServerRoute = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createServerRoute(deps: ServerRouteDeps): ServerRoute {
  return async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "OPTIONS") {
      sendJson(res, 204, null);
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, deps.shellApi.health());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/prs") {
      sendJson(res, 200, await deps.shellApi.prs());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/logs") {
      sendJson(res, 200, deps.shellApi.logs());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/review-memory") {
      sendJson(res, 200, await deps.reviewMemoryApi.status(url.searchParams.get("limit")));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/review-memory/distill") {
      deps.logger.info("api", "review memory distillation requested");
      sendJson(res, 200, await deps.reviewMemoryApi.distill());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/review-memory/capture") {
      const payload = recordFromBody(await readBody(req));
      const response = await deps.reviewMemoryApi.capture(payload);
      deps.logger.info("api", "review memory captured", { prKey: payload.prKey, comments: response.memory.comments.length, event: payload.event });
      sendJson(res, 200, response);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/pr/parse") {
      const input = inputFromBody(await readBody(req));
      deps.logger.info("api", "parse PR input", { input });
      sendJson(res, 200, deps.prApi.parse(input));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/pr/cleanup") {
      const input = inputFromBody(await readBody(req));
      deps.logger.info("api", "cleanup PR requested", { input });
      const response = await deps.prApi.cleanup(input);
      deps.logger.info("api", "cleanup PR complete", { prKey: response.prKey, worktreeDir: response.worktreeDir });
      sendJson(res, 200, response);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/pr/activity") {
      const input = inputFromBody(await readBody(req));
      deps.logger.info("api", "refresh PR activity requested", { input });
      const response = await deps.prApi.activity(input);
      deps.logger.info("api", "refresh PR activity complete", { key: response.pr.key, existingCommentCount: response.pr.existingCommentCount });
      sendJson(res, 200, response);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/draft-review/save") {
      const payload = recordFromBody(await readBody(req));
      const response = await deps.draftReviewApi.save(payload);
      deps.logger.info("api", "draft review saved", { prKey: response.draftReview.prKey, comments: response.draftReview.comments.length });
      sendJson(res, 200, response);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/file/viewed") {
      const payload = recordFromBody(await readBody(req));
      deps.logger.info("api", "set file viewed", payload);
      sendJson(res, 200, await deps.fileApi.viewed(payload));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/file/text") {
      sendJson(res, 200, await deps.fileApi.text(recordFromBody(await readBody(req))));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/file/open") {
      sendJson(res, 200, await deps.fileApi.open(recordFromBody(await readBody(req))));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ask/stream") {
      await deps.askStreamApi.stream(res, recordFromBody(await readBody(req)));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ask") {
      sendJson(res, 200, await deps.piApi.ask(recordFromBody(await readBody(req))));
      return;
    }

    if (req.method === "POST" && (url.pathname === "/api/pi/review/status" || url.pathname === "/api/pi/focus-review/status")) {
      sendJson(res, 200, await deps.piApi.jobStatus(recordFromBody(await readBody(req))));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/pi/prompt") {
      sendJson(res, 200, await deps.reviewPromptApi.build(recordFromBody(await readBody(req))));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/pi/review") {
      const payload = recordFromBody(await readBody(req));
      const response = await deps.piApi.startReviewJob(payload, "main-review");
      deps.logger.info("api", "main review job started", { prKey: payload.prKey, jobId: response.job.id });
      sendJson(res, 202, response);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/pi/focus-review") {
      const payload = recordFromBody(await readBody(req));
      const response = await deps.piApi.startReviewJob(payload, "focus-review");
      deps.logger.info("api", "focus review job started", { prKey: payload.prKey, jobId: response.job.id });
      sendJson(res, 202, response);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/focus-scan/save") {
      sendJson(res, 200, await deps.savedAnalysisApi.saveFocusScan(recordFromBody(await readBody(req))));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/ai-review/save") {
      sendJson(res, 200, await deps.savedAnalysisApi.saveAiReview(recordFromBody(await readBody(req))));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/pi/diagnostics") {
      sendJson(res, 200, await deps.piApi.diagnostics(recordFromBody(await readBody(req))));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/pi/model") {
      sendJson(res, 200, await deps.piApi.setModel(recordFromBody(await readBody(req))));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/gpu/workspaces/status") {
      sendJson(res, 200, await deps.gpuWorkspaceStatusResponse(recordFromBody(await readBody(req))));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/gpu/workspaces") {
      const payload = recordFromBody(await readBody(req));
      deps.logger.info("api", "gpu workspace requested", { prUrl: payload.prUrl, gpuType: payload.gpuType });
      const response = await deps.gpuWorkspaceCreateResponse(payload);
      const workspace = response.workspace as { gpuType?: unknown; id?: unknown; uri?: unknown } | undefined;
      deps.logger.info("api", "gpu workspace ready", { gpuType: workspace?.gpuType, id: workspace?.id, uri: workspace?.uri, reused: response.reused });
      sendJson(res, 200, response);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/gpu/workspaces/delete") {
      const payload = recordFromBody(await readBody(req));
      deps.logger.info("api", "gpu workspace delete requested", { id: payload.id });
      const response = await deps.gpuWorkspaceDeleteResponse(payload);
      const result = response.result as { id?: unknown } | undefined;
      deps.logger.info("api", "gpu workspace deleted", { id: result?.id });
      sendJson(res, 200, response);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/gpu/workspaces/exec") {
      const payload = recordFromBody(await readBody(req));
      deps.logger.info("api", "gpu workspace exec requested", { id: payload.id, command: payload.command });
      const response = await deps.gpuWorkspaceExecResponse(payload);
      const result = response.result as { id?: unknown; exitCode?: unknown; signal?: unknown } | undefined;
      deps.logger.info("api", "gpu workspace exec complete", { id: result?.id, exitCode: result?.exitCode, signal: result?.signal });
      sendJson(res, 200, response);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/review/submit") {
      const payload = recordFromBody(await readBody(req));
      deps.logger.info("api", "submit review requested", { prUrl: payload.prUrl, comments: Array.isArray(payload.comments) ? payload.comments.length : 0, event: payload.event });
      sendJson(res, 200, await deps.reviewSubmitRouteApi.submit(payload));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/comment/reply") {
      sendJson(res, 200, await deps.commentApi.reply(recordFromBody(await readBody(req))));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/comment/edit") {
      sendJson(res, 200, await deps.commentApi.edit(recordFromBody(await readBody(req))));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/pr/open") {
      const input = inputFromBody(await readBody(req));
      deps.logger.info("api", "open PR requested", { input });
      const response = await deps.prApi.open(input);
      deps.logger.info("api", "open PR complete", { key: response.pr.key, filesChanged: response.pr.filesChanged, existingCommentCount: response.pr.existingCommentCount, worktreeDir: response.worktreeDir });
      sendJson(res, 200, response);
      return;
    }

    if (req.method === "GET" || req.method === "HEAD") {
      await deps.sendStatic(res, url.pathname, req.method === "HEAD");
      return;
    }

    sendJson(res, 404, { error: `No route for ${req.method ?? "GET"} ${url.pathname}` });
  };
}

export function createRequestListener(route: ServerRoute, logger: Pick<ServerLogger, "error" | "info">): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const startedAt = performance.now();
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    const shouldLogRequest = method !== "GET";
    if (shouldLogRequest) logger.info("http", "request start", { method, url });
    res.on("finish", () => {
      if (shouldLogRequest) logger.info("http", "request finish", { method, url, status: res.statusCode, ms: Math.round(performance.now() - startedAt) });
    });
    route(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof MalformedJsonError ? 400 : 500;
      logger.error("http", "request failed", { method, url, error: message });
      sendJson(res, status, { error: message });
    });
  };
}
