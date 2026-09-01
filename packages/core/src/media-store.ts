export type StoredMediaObject = {
  key: string;
  path: string;
  contentType: string;
  sizeBytes: number;
};

export type MediaObject = StoredMediaObject & { bytes: Uint8Array };

export type MediaReference = {
  key: string;
  path: string;
};

export interface MediaStore {
  put(input: {
    projectId: string;
    bytes: Uint8Array;
    contentType: string;
    extension: string;
  }): Promise<StoredMediaObject>;
  get(key: string): Promise<MediaObject | null>;
  resolve(projectId: string, value: string): MediaReference | null;
  publicUrl(path: string): string;
}
