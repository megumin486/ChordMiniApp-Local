/**
 * Firebase offload upload service: placeholder implementation for the local build.
 *
 * Upstream used Firebase Storage to stage large files before handing them to the
 * backend, together with the now-deleted `/api/*-offload` routes that worked
 * around the serverless body limit. The local build has no object storage and no
 * offload routes (removed in Phase 2), so every upload goes straight to Flask as
 * multipart.
 *
 * Method names and return shapes are preserved, so call sites (chordService /
 * beatDetectionService / sheetSageTranscriptionClient / audioAnalysisService)
 * need no changes: `shouldUseOffloadUpload()` is always false, so no offload
 * branch ever runs. No network, no dependencies.
 */

export interface OffloadUploadResult {
  success: boolean;
  data?: unknown;
  error?: string;
  offloadUrl?: string;
  processingTime?: number;
}

const OFFLOAD_UNAVAILABLE = 'offload upload is not available in the local-only build';

class OffloadUploadService {
  /** Offload is permanently disabled locally: every upload is direct multipart. */
  shouldUseOffloadUpload(_fileSize?: number): boolean {
    return false;
  }

  isOffloadUploadAvailable(): boolean {
    return false;
  }

  getFileSizeString(bytes: number): string {
    const mb = bytes / 1024 / 1024;
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
  }

  async uploadToOffload(_audioFile: File): Promise<string> {
    throw new Error(OFFLOAD_UNAVAILABLE);
  }

  async detectBeatsFromOffloadUrl(
    _offloadUrl: string,
    _detector: 'auto' | 'madmom' | 'beat-transformer' = 'beat-transformer',
    _options: { deleteAfterProcessing?: boolean; audioDuration?: number } = {},
  ): Promise<OffloadUploadResult> {
    return { success: false, error: OFFLOAD_UNAVAILABLE };
  }

  async recognizeChordsFromOffloadUrl(
    _offloadUrl: string,
    _model: string = 'chord-cnn-lstm',
    _options: { deleteAfterProcessing?: boolean } = {},
  ): Promise<OffloadUploadResult> {
    return { success: false, error: OFFLOAD_UNAVAILABLE };
  }

  async transcribeSheetSageOffloadUpload(
    _audioFile: File,
    _videoId?: string,
  ): Promise<OffloadUploadResult> {
    return { success: false, error: OFFLOAD_UNAVAILABLE };
  }

  /**
   * Upstream branched by environment (direct locally / offload in production).
   * The local build always returns `USE_STANDARD_FLOW`, so callers upload directly.
   */
  async processAudioFile(
    _audioFile: File,
    _operation: 'detect-beats' | 'recognize-chords',
    _options: {
      detector?: 'auto' | 'madmom' | 'beat-transformer';
      model?: string;
      onProgress?: (percent: number) => void;
    } = {},
  ): Promise<OffloadUploadResult> {
    return { success: false, error: 'USE_STANDARD_FLOW' };
  }
}

export const offloadUploadService = new OffloadUploadService();