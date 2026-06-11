import { randomUUID } from "node:crypto";

export type PiJob = {
  id: string;
  prKey: string;
  purpose?: string;
  status: "running" | "complete" | "failed";
  answer?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
};

export type AskPiForJob = (prKey: string, prompt: string, purpose?: string) => Promise<string>;

export type PiJobRunner = {
  startJob: (prKey: string, prompt: string, purpose?: string) => PiJob;
  getJob: (jobId: string) => PiJob | null;
};

export function createPiJobRunner(askPi: AskPiForJob, options: { newId?: () => string; now?: () => string } = {}): PiJobRunner {
  const jobs = new Map<string, PiJob>();
  const newId = options.newId ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());

  function startJob(prKey: string, prompt: string, purpose?: string): PiJob {
    const job: PiJob = { id: newId(), prKey, purpose, status: "running", startedAt: now() };
    jobs.set(job.id, job);
    void askPi(prKey, prompt, purpose).then((answer) => {
      jobs.set(job.id, { ...job, status: "complete", answer, finishedAt: now() });
    }).catch((error: unknown) => {
      jobs.set(job.id, { ...job, status: "failed", error: error instanceof Error ? error.message : String(error), finishedAt: now() });
    });
    return job;
  }

  function getJob(jobId: string): PiJob | null {
    return jobs.get(jobId) ?? null;
  }

  return { startJob, getJob };
}
