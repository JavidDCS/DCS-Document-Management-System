import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { HttpError, type FieldIssue } from '../../utils/httpError.js';

interface Schemas {
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
}

/**
 * Validates params, query and body with Zod and replaces them with the parsed values.
 * Use strict objects (`z.strictObject`) so unknown keys are rejected.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    const details: FieldIssue[] = [];
    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part]);
      if (!result.success) {
        details.push(...result.error.issues.map((i) => ({ path: [part, ...i.path].join('.'), message: i.message })));
      } else {
        // Express types these as fixed shapes; the parsed value is what handlers should see.
        (req as unknown as Record<string, unknown>)[part] = result.data;
      }
    }
    if (details.length > 0) return next(new HttpError(400, 'Invalid request', 'VALIDATION_ERROR', details));
    next();
  };
}
