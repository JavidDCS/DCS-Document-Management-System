-- CreateTable
CREATE TABLE "email_templates" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by_id" UUID,
    "updated_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "email_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_provider_connections" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'gmail',
    "scopes" TEXT[],
    "refresh_token_ciphertext" BYTEA,
    "key_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "connected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "email_provider_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_oauth_states" (
    "id" UUID NOT NULL,
    "state_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "code_verifier_ciphertext" BYTEA NOT NULL,
    "key_id" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_messages" (
    "id" UUID NOT NULL,
    "sender_user_id" UUID NOT NULL,
    "connection_id" UUID,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "subject" TEXT NOT NULL,
    "body_text" TEXT NOT NULL,
    "from_address" TEXT NOT NULL,
    "reply_to_address" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "provider_message_id" TEXT,
    "external_confirmed" BOOLEAN NOT NULL DEFAULT false,
    "error_code" TEXT,
    "template_id" UUID,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "email_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_recipients" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "is_external" BOOLEAN NOT NULL,

    CONSTRAINT "email_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_attachments" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "sha256_at_send" CHAR(64) NOT NULL,
    "filename_sent" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,

    CONSTRAINT "email_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_templates_created_by_id_idx" ON "email_templates"("created_by_id");

-- CreateIndex
CREATE INDEX "email_templates_updated_by_id_idx" ON "email_templates"("updated_by_id");

-- CreateIndex
CREATE INDEX "email_templates_is_active_idx" ON "email_templates"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "email_provider_connections_user_id_key" ON "email_provider_connections"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_oauth_states_state_hash_key" ON "email_oauth_states"("state_hash");

-- CreateIndex
CREATE INDEX "email_oauth_states_user_id_idx" ON "email_oauth_states"("user_id");

-- CreateIndex
CREATE INDEX "email_oauth_states_expires_at_idx" ON "email_oauth_states"("expires_at");

-- CreateIndex
CREATE INDEX "email_messages_sender_user_id_created_at_idx" ON "email_messages"("sender_user_id", "created_at");

-- CreateIndex
CREATE INDEX "email_messages_connection_id_idx" ON "email_messages"("connection_id");

-- CreateIndex
CREATE INDEX "email_messages_template_id_idx" ON "email_messages"("template_id");

-- CreateIndex
CREATE INDEX "email_messages_status_idx" ON "email_messages"("status");

-- CreateIndex
CREATE INDEX "email_messages_created_at_idx" ON "email_messages"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_sender_user_id_idempotency_key_key" ON "email_messages"("sender_user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "email_recipients_message_id_idx" ON "email_recipients"("message_id");

-- CreateIndex
CREATE INDEX "email_recipients_address_idx" ON "email_recipients"("address");

-- CreateIndex
CREATE INDEX "email_recipients_domain_idx" ON "email_recipients"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "email_recipients_message_id_kind_address_key" ON "email_recipients"("message_id", "kind", "address");

-- CreateIndex
CREATE INDEX "email_attachments_message_id_idx" ON "email_attachments"("message_id");

-- CreateIndex
CREATE INDEX "email_attachments_document_id_idx" ON "email_attachments"("document_id");

-- CreateIndex
CREATE INDEX "email_attachments_version_id_idx" ON "email_attachments"("version_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_attachments_message_id_version_id_key" ON "email_attachments"("message_id", "version_id");

-- AddForeignKey
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_provider_connections" ADD CONSTRAINT "email_provider_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_oauth_states" ADD CONSTRAINT "email_oauth_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "email_provider_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "email_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_recipients" ADD CONSTRAINT "email_recipients_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "email_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_attachments" ADD CONSTRAINT "email_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "email_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_attachments" ADD CONSTRAINT "email_attachments_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_attachments" ADD CONSTRAINT "email_attachments_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "document_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written additions (not generated by Prisma)
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "email_templates_name_lower_key" ON "email_templates" (lower("name"));

ALTER TABLE "email_templates"
  ADD CONSTRAINT "email_templates_name_length_check" CHECK (char_length("name") BETWEEN 1 AND 100),
  ADD CONSTRAINT "email_templates_subject_check" CHECK (char_length("subject") BETWEEN 1 AND 200 AND "subject" !~ '[\r\n]'),
  ADD CONSTRAINT "email_templates_body_check" CHECK (char_length("body") BETWEEN 1 AND 10000),
  ADD CONSTRAINT "email_templates_version_check" CHECK ("version" >= 1);
-- Only one default template at a time
CREATE UNIQUE INDEX "email_templates_single_default_key" ON "email_templates" ("is_default") WHERE "is_default";

ALTER TABLE "email_provider_connections"
  ADD CONSTRAINT "email_provider_connections_provider_check" CHECK ("provider" = 'gmail'),
  ADD CONSTRAINT "email_provider_connections_status_check" CHECK ("status" IN ('ACTIVE', 'REVOKED', 'ERROR')),
  ADD CONSTRAINT "email_provider_connections_scope_check" CHECK ("scopes" = ARRAY['https://www.googleapis.com/auth/gmail.send']::text[]),
  ADD CONSTRAINT "email_provider_connections_token_check" CHECK (("status" = 'ACTIVE') = ("refresh_token_ciphertext" IS NOT NULL));

ALTER TABLE "email_messages"
  ADD CONSTRAINT "email_messages_status_check" CHECK ("status" IN ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN')),
  ADD CONSTRAINT "email_messages_from_equals_reply_to_check" CHECK ("from_address" = "reply_to_address"),
  ADD CONSTRAINT "email_messages_subject_check" CHECK (char_length("subject") BETWEEN 1 AND 200 AND "subject" !~ '[\r\n]'),
  ADD CONSTRAINT "email_messages_hash_check" CHECK ("request_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "email_messages_sent_pair_check" CHECK (("status" = 'SENT') = ("sent_at" IS NOT NULL));

ALTER TABLE "email_recipients"
  ADD CONSTRAINT "email_recipients_kind_check" CHECK ("kind" IN ('TO', 'CC', 'BCC')),
  ADD CONSTRAINT "email_recipients_address_check" CHECK ("address" = lower("address") AND "address" ~ '^[^@[:space:],;<>]+@[^@[:space:],;<>]+$'),
  ADD CONSTRAINT "email_recipients_domain_check" CHECK ("domain" = split_part("address", '@', 2));

ALTER TABLE "email_attachments"
  ADD CONSTRAINT "email_attachments_sha256_check" CHECK ("sha256_at_send" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "email_attachments_size_check" CHECK ("size_bytes" >= 0);

-- Sent-mail records are immutable: no DELETE; only the delivery outcome may change, and only forward.
CREATE FUNCTION email_messages_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'email_messages is immutable (DELETE is not allowed)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.sender_user_id, NEW.idempotency_key, NEW.request_hash, NEW.subject, NEW.body_text, NEW.from_address,
      NEW.reply_to_address, NEW.external_confirmed, NEW.template_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.sender_user_id, OLD.idempotency_key, OLD.request_hash, OLD.subject, OLD.body_text, OLD.from_address,
      OLD.reply_to_address, OLD.external_confirmed, OLD.template_id, OLD.created_at)
  THEN
    RAISE EXCEPTION 'email_messages is immutable (only the delivery outcome may change)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'QUEUED' AND NEW.status IN ('SENDING', 'FAILED'))
    OR (OLD.status = 'SENDING' AND NEW.status IN ('SENT', 'FAILED', 'UNKNOWN'))
    OR (OLD.status = 'UNKNOWN' AND NEW.status IN ('SENT', 'FAILED'))
  ) THEN
    RAISE EXCEPTION 'Invalid email status change % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('SENT', 'FAILED') AND (NEW.provider_message_id, NEW.error_code, NEW.sent_at)
       IS DISTINCT FROM (OLD.provider_message_id, OLD.error_code, OLD.sent_at) THEN
    RAISE EXCEPTION 'The outcome of a sent email is final' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "email_messages_guard"
  BEFORE UPDATE OR DELETE ON "email_messages"
  FOR EACH ROW EXECUTE FUNCTION email_messages_guard();

CREATE FUNCTION email_children_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable (% is not allowed)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "email_recipients_immutable"
  BEFORE UPDATE OR DELETE ON "email_recipients"
  FOR EACH ROW EXECUTE FUNCTION email_children_immutable();

CREATE TRIGGER "email_attachments_immutable"
  BEFORE UPDATE OR DELETE ON "email_attachments"
  FOR EACH ROW EXECUTE FUNCTION email_children_immutable();
