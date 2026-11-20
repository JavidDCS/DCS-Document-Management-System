export class StirlingPdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StirlingPdfError';
  }
}

export interface StirlingPdfConfig {
  url: string | undefined;
  apiKey: string | undefined;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Pushes a document into a self-hosted Stirling-PDF instance's own file storage, so staff find it waiting in
 * their file library (sorted newest-first, so it's always the top row) instead of downloading and re-uploading
 * it by hand. A share link was tried first but does nothing useful here: the API key's owner and the staff
 * member opening the link are the same single account, and Stirling-PDF only treats a share link specially for
 * a DIFFERENT recipient account -- for the file's own owner it just lands on the plain home screen.
 *
 * There is no way to automatically pull an edit back out: Stirling-PDF's own PDF Text Editor tool has no
 * webhook, and its Save/Download actions never call its own storage API at all (confirmed by editing a file
 * there, clicking Save, then reading that file back from the storage API -- the stored bytes never changed).
 * Staff finish by downloading the edited file from Stirling-PDF themselves and using "Upload new version" here.
 *
 * Entirely optional: with no URL/key configured, `available` is false and callers fall back to manual download.
 */
export class StirlingPdfProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: StirlingPdfConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
  }

  get available(): boolean {
    return Boolean(this.cfg.url && this.cfg.apiKey);
  }

  private need() {
    if (!this.available) throw new StirlingPdfError('Stirling-PDF is not configured');
    return { base: this.cfg.url!.replace(/\/+$/, ''), apiKey: this.cfg.apiKey! };
  }

  private async call(url: string, apiKey: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, { ...init, headers: { ...init.headers, 'X-API-KEY': apiKey }, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new StirlingPdfError('Could not reach Stirling-PDF');
    }
  }

  /** Uploads the bytes and returns the URL to Stirling-PDF's file library, where the upload is always the newest row. */
  async createEditorLink(pdfBytes: Buffer, filename: string): Promise<{ url: string }> {
    const { base, apiKey } = this.need();

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' }), filename);
    const upload = await this.call(`${base}/api/v1/storage/files`, apiKey, { method: 'POST', body: form });
    const uploaded = (await upload.json().catch(() => ({}))) as { id?: number };
    if (!upload.ok || uploaded.id === undefined) throw new StirlingPdfError(`Stirling-PDF did not accept the upload (${upload.status})`);

    return { url: `${base}/files` };
  }
}
