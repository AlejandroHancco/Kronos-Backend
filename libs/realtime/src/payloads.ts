export interface JobStatusPayload {
  jobId: string;
  taskId?: number;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'retrying';
  attempt?: number;
  error?: string;
}

/** Notificación in-app: se emite tal cual (mismo shape que antes del split). */
export type NotificationPayload = Record<string, unknown>;
