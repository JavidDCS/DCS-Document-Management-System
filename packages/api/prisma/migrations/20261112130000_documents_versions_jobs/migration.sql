-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "document_type_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "fields_version" INTEGER NOT NULL DEFAULT 1,
    "search_text" TEXT NOT NULL DEFAULT '',
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "archive_status" TEXT NOT NULL DEFAULT 'LIVE',
    "current_version_id" UUID,
    "owner_id" UUID NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_versions" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "storage_key" UUID NOT NULL,
    "original_filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "stored_size" BIGINT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "encryption_key_id" TEXT NOT NULL,
    "wrapped_data_key" BYTEA NOT NULL,
    "scan_status" TEXT NOT NULL DEFAULT 'PENDING',
    "scan_details" JSONB,
    "scanned_at" TIMESTAMPTZ(3),
    "change_note" TEXT,
    "restored_from_version_id" UUID,
    "uploaded_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_tags" (
    "document_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,

    CONSTRAINT "document_tags_pkey" PRIMARY KEY ("document_id","tag_id")
);

-- CreateTable
CREATE TABLE "document_access_rules" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "user_id" UUID,
    "role" TEXT,
    "permission" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_access_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "background_jobs" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "background_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "documents_document_type_id_idx" ON "documents"("document_type_id");

-- CreateIndex
CREATE INDEX "documents_owner_id_idx" ON "documents"("owner_id");

-- CreateIndex
CREATE INDEX "documents_created_by_id_idx" ON "documents"("created_by_id");

-- CreateIndex
CREATE INDEX "documents_current_version_id_idx" ON "documents"("current_version_id");

-- CreateIndex
CREATE INDEX "documents_is_active_archive_status_idx" ON "documents"("is_active", "archive_status");

-- CreateIndex
CREATE INDEX "documents_updated_at_idx" ON "documents"("updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_storage_key_key" ON "document_versions"("storage_key");

-- CreateIndex
CREATE INDEX "document_versions_document_id_idx" ON "document_versions"("document_id");

-- CreateIndex
CREATE INDEX "document_versions_uploaded_by_id_idx" ON "document_versions"("uploaded_by_id");

-- CreateIndex
CREATE INDEX "document_versions_restored_from_version_id_idx" ON "document_versions"("restored_from_version_id");

-- CreateIndex
CREATE INDEX "document_versions_scan_status_idx" ON "document_versions"("scan_status");

-- CreateIndex
CREATE UNIQUE INDEX "document_versions_document_id_version_number_key" ON "document_versions"("document_id", "version_number");

-- CreateIndex
CREATE INDEX "document_tags_tag_id_idx" ON "document_tags"("tag_id");

-- CreateIndex
CREATE INDEX "document_access_rules_document_id_idx" ON "document_access_rules"("document_id");

-- CreateIndex
CREATE INDEX "document_access_rules_user_id_idx" ON "document_access_rules"("user_id");

-- CreateIndex
CREATE INDEX "document_access_rules_created_by_id_idx" ON "document_access_rules"("created_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "background_jobs_dedupe_key_key" ON "background_jobs"("dedupe_key");

-- CreateIndex
CREATE INDEX "background_jobs_status_available_at_idx" ON "background_jobs"("status", "available_at");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_document_type_id_fkey" FOREIGN KEY ("document_type_id") REFERENCES "document_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_current_version_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_restored_from_version_id_fkey" FOREIGN KEY ("restored_from_version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_tags" ADD CONSTRAINT "document_tags_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_tags" ADD CONSTRAINT "document_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_access_rules" ADD CONSTRAINT "document_access_rules_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_access_rules" ADD CONSTRAINT "document_access_rules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_access_rules" ADD CONSTRAINT "document_access_rules_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written additions (not generated by Prisma)
-- ---------------------------------------------------------------------------

ALTER TABLE "documents"
  ADD CONSTRAINT "documents_name_length_check" CHECK (char_length("name") BETWEEN 1 AND 200),
  ADD CONSTRAINT "documents_archive_status_check" CHECK ("archive_status" IN ('LIVE', 'ARCHIVED', 'LEGAL_HOLD')),
  ADD CONSTRAINT "documents_active_needs_current_version_check" CHECK (NOT "is_active" OR "current_version_id" IS NOT NULL),
  ADD CONSTRAINT "documents_archived_not_active_check" CHECK ("archive_status" = 'LIVE' OR NOT "is_active");

-- Fuzzy search on name and searchable metadata
CREATE INDEX "documents_name_trgm_idx" ON "documents" USING gin ("name" gin_trgm_ops);
CREATE INDEX "documents_search_text_trgm_idx" ON "documents" USING gin ("search_text" gin_trgm_ops);

ALTER TABLE "document_versions"
  ADD CONSTRAINT "document_versions_number_check" CHECK ("version_number" >= 1),
  ADD CONSTRAINT "document_versions_scan_status_check" CHECK ("scan_status" IN ('PENDING', 'CLEAN', 'QUARANTINED', 'REJECTED')),
  ADD CONSTRAINT "document_versions_scan_pair_check" CHECK (("scan_status" = 'PENDING') = ("scanned_at" IS NULL)),
  ADD CONSTRAINT "document_versions_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "document_versions_sizes_check" CHECK ("size_bytes" >= 0 AND "stored_size" > 0),
  ADD CONSTRAINT "document_versions_mime_check" CHECK ("mime_type" = 'application/pdf'),
  ADD CONSTRAINT "document_versions_filename_check" CHECK (char_length("original_filename") BETWEEN 1 AND 255);

-- A document may only point at a CLEAN version of itself.
CREATE FUNCTION documents_current_version_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM document_versions v
    WHERE v.id = NEW.current_version_id AND v.document_id = NEW.id AND v.scan_status = 'CLEAN'
  ) THEN
    RAISE EXCEPTION 'The current version must be a CLEAN version of the same document'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "documents_current_version_guard"
  BEFORE INSERT OR UPDATE OF "current_version_id" ON "documents"
  FOR EACH ROW EXECUTE FUNCTION documents_current_version_guard();

-- Versions are immutable. The only permitted change is the one-way scan result (PENDING -> final).
CREATE FUNCTION document_versions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'document_versions is immutable (DELETE is not allowed)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.document_id, NEW.version_number, NEW.storage_key, NEW.original_filename, NEW.mime_type, NEW.size_bytes,
      NEW.stored_size, NEW.sha256, NEW.encryption_key_id, NEW.wrapped_data_key, NEW.change_note,
      NEW.restored_from_version_id, NEW.uploaded_by_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.document_id, OLD.version_number, OLD.storage_key, OLD.original_filename, OLD.mime_type, OLD.size_bytes,
      OLD.stored_size, OLD.sha256, OLD.encryption_key_id, OLD.wrapped_data_key, OLD.change_note,
      OLD.restored_from_version_id, OLD.uploaded_by_id, OLD.created_at)
  THEN
    RAISE EXCEPTION 'document_versions is immutable (only the scan result may change)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.scan_status <> 'PENDING' AND (NEW.scan_status, NEW.scan_details, NEW.scanned_at)
       IS DISTINCT FROM (OLD.scan_status, OLD.scan_details, OLD.scanned_at) THEN
    RAISE EXCEPTION 'The scan result of a version is final' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "document_versions_guard"
  BEFORE UPDATE OR DELETE ON "document_versions"
  FOR EACH ROW EXECUTE FUNCTION document_versions_guard();

ALTER TABLE "document_access_rules"
  ADD CONSTRAINT "document_access_rules_subject_check" CHECK (
    ("subject_type" = 'USER' AND "user_id" IS NOT NULL AND "role" IS NULL)
    OR ("subject_type" = 'ROLE' AND "role" IN ('SUPER_ADMIN', 'ADMIN', 'SENDER', 'VIEWER') AND "user_id" IS NULL)
  ),
  ADD CONSTRAINT "document_access_rules_permission_check" CHECK ("permission" IN ('VIEW', 'SEND')),
  ADD CONSTRAINT "document_access_rules_effect_check" CHECK ("effect" IN ('ALLOW', 'DENY'));

ALTER TABLE "background_jobs"
  ADD CONSTRAINT "background_jobs_status_check" CHECK ("status" IN ('PENDING', 'PROCESSING', 'DONE', 'DEAD')),
  ADD CONSTRAINT "background_jobs_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "background_jobs_type_check" CHECK ("type" ~ '^[a-z][a-z0-9_]{1,63}$');
