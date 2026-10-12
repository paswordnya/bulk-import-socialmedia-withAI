export const JOB_STATUSES = [
  'PENDING',
  'FETCHING',
  'DOWNLOADING',
  'STORING',
  'COMPLETED',
  'FAILED',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export type ErrorCode =
  | 'INVALID_URL'
  | 'UNSUPPORTED_PLATFORM'
  | 'PRIVATE_CONTENT'
  | 'VIDEO_UNAVAILABLE'
  | 'PROVIDER_ERROR'
  | 'IMPORT_TIMEOUT'
  | 'STORAGE_ERROR'
  | 'INVALID_MEDIA'
  | 'VIDEO_TOO_LONG'
  | 'FILE_TOO_LARGE'
  | 'EMBEDDING_DISABLED'
  | 'UNKNOWN_ERROR';

const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  PENDING: ['FETCHING', 'FAILED'],
  FETCHING: ['DOWNLOADING', 'FAILED'],
  DOWNLOADING: ['STORING', 'FAILED'],
  STORING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
};

export const PROGRESS: Record<JobStatus, number> = {
  PENDING: 0,
  FETCHING: 20,
  DOWNLOADING: 60,
  STORING: 85,
  COMPLETED: 100,
  FAILED: 0,
};

export class InvalidTransitionError extends Error {
  constructor(from: JobStatus, to: JobStatus) {
    super(`Invalid job transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(status: JobStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** User-facing copy. Provider internals are never surfaced. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  INVALID_URL: 'Please enter a valid video URL from TikTok, Instagram, Facebook, X, Pinterest, Reddit, Threads or YouTube.',
  UNSUPPORTED_PLATFORM: "This URL isn't supported. Please paste a video URL from TikTok, Instagram, Facebook, X, Pinterest, Reddit, Threads or YouTube.",
  PRIVATE_CONTENT: "This content isn't publicly accessible. Please try another video.",
  VIDEO_UNAVAILABLE: 'This video is no longer available.',
  PROVIDER_ERROR: "We couldn't import this video right now. Please try again.",
  IMPORT_TIMEOUT: 'The video is taking too long to process. Please try again.',
  STORAGE_ERROR: "We couldn't import this video right now. Please try again.",
  INVALID_MEDIA: "This content type isn't supported. Please use a public video or Reel.",
  VIDEO_TOO_LONG: 'This video is too long to import. Please try a shorter video.',
  FILE_TOO_LARGE: 'This video file is too large to import. Please try a smaller video.',
  EMBEDDING_DISABLED: "The owner doesn't allow this video to be played outside YouTube.",
  UNKNOWN_ERROR: "We couldn't import this video right now. Please try again.",
};
