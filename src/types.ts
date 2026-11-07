export interface TndConfig {
  apiBase: string
  apiPassword?: string
  maxSearchResults: number
  initialWait: number
  pollInterval: number
  jobTimeout: number
  fileSendMaxRetries: number
  transferMode: 'auto' | 'url' | 'file' | 'base64'
  cleanupJob: boolean
  quickDownload: boolean
  cooldown: number
  maxConcurrentJobs: number
  maxTextLength: number
  enableImage: boolean
  imageWidth: number
  debug: boolean
}

export interface BookItem {
  book_id: string
  title: string
  author?: string
}

export interface Preview {
  book_id: string
  book_name: string
  author?: string
  category?: string
  description?: string
  chapter_count?: number
  word_count?: number
  finished?: boolean
  score?: number
  cover_url?: string
}

export interface JobProgress {
  saved_chapters?: number
  chapter_total?: number
  group_done?: number
  group_total?: number
  save_phase?: string
}

export interface JobOption {
  label: string
  value: string
}

export interface Job {
  id: number
  book_id: string
  title?: string
  state?: 'queued' | 'running' | 'done' | 'failed' | 'canceled' | string
  message?: string | null
  created_ms?: number
  progress?: JobProgress
  book_name_options?: JobOption[] | null
  format_options?: JobOption[] | null
}

export interface LibraryItem {
  kind: 'file' | 'dir' | string
  name: string
  rel_path: string
  size?: number
  modified_ms?: number
}

export interface ServiceStatus {
  locked?: boolean
  save_dir?: string
  version?: string
}

export interface FullConfig {
  save_path?: string
  novel_format?: string
  bulk_files?: boolean
  ask_format_after_download?: boolean
}
