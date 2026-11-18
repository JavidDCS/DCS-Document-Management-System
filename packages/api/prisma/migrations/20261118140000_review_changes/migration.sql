-- External review, round 2: many comments per link, and suggested text changes ("CHANGE") that staff can apply to the PDF.

-- v1 allowed one OPEN comment per share link. A client now raises as many comments/changes as they need; staff resolve
-- them one by one, and the link closes itself when none is left open (see ReviewService).
DROP INDEX IF EXISTS "document_review_comments_one_open_per_link";

ALTER TABLE "document_review_comments"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'COMMENT',
  ADD COLUMN "box_w_pct" DOUBLE PRECISION,
  ADD COLUMN "box_h_pct" DOUBLE PRECISION,
  ADD COLUMN "original_text" TEXT,
  ADD COLUMN "replacement_text" TEXT;

ALTER TABLE "document_review_comments"
  ADD CONSTRAINT "document_review_comments_kind_check" CHECK ("kind" IN ('COMMENT', 'CHANGE')),
  ADD CONSTRAINT "document_review_comments_original_text_check" CHECK ("original_text" IS NULL OR char_length("original_text") <= 300),
  -- A COMMENT is a plain pin. A CHANGE is a box (x_pct/y_pct = top-left corner) plus the new text, fully inside the page.
  ADD CONSTRAINT "document_review_comments_shape_check" CHECK (
    ("kind" = 'COMMENT' AND "box_w_pct" IS NULL AND "box_h_pct" IS NULL AND "replacement_text" IS NULL AND "original_text" IS NULL)
    OR
    ("kind" = 'CHANGE'
      AND "box_w_pct" > 0 AND "box_h_pct" > 0
      AND "x_pct" + "box_w_pct" <= 1.000001 AND "y_pct" + "box_h_pct" <= 1.000001
      AND "replacement_text" IS NOT NULL AND char_length("replacement_text") BETWEEN 1 AND 300)
  );

CREATE INDEX "document_review_comments_kind_idx" ON "document_review_comments"("kind");
