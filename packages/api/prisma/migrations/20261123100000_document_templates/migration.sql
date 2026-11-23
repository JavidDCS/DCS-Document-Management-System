-- The Word (.docx) version of an agreement, with {{blanks}} for the changing parts. New table only; nothing existing is changed.
CREATE TABLE "document_templates" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "storage_key" UUID NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "stored_size" BIGINT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "encryption_key_id" TEXT NOT NULL,
    "wrapped_data_key" BYTEA NOT NULL,
    "blanks" TEXT[],
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "document_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "document_templates_document_id_key" ON "document_templates"("document_id");
CREATE UNIQUE INDEX "document_templates_storage_key_key" ON "document_templates"("storage_key");
CREATE INDEX "document_templates_uploaded_by_id_idx" ON "document_templates"("uploaded_by_id");

ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
