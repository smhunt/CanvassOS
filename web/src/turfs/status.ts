import type { AssignmentStatus } from '../api/types';

export const STATUS_LABELS: Record<AssignmentStatus, string> = {
  open: 'Not started',
  in_progress: 'In progress',
  done: 'Done',
};

/** Maps onto the shared `.tag--*` tones in styles.css. */
export const STATUS_TONE: Record<AssignmentStatus, 'neutral' | 'warn' | 'ok'> = {
  open: 'neutral',
  in_progress: 'warn',
  done: 'ok',
};
