import { BadRequestException } from '@nestjs/common';

// Central DTO validation. This repo has no global ValidationPipe and validates
// by throwing BadRequestException from the service layer; this helper keeps that
// convention in one place so a missing required field always fails closed with a
// 400 that names exactly what was missing (and no side effect is performed).
export function requireFields<T extends Record<string, unknown>>(
  body: T | undefined | null,
  fields: Array<keyof T & string>,
): void {
  const source = body ?? ({} as T);
  const missing = fields.filter((field) => {
    const value = source[field];
    return (
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim() === '')
    );
  });
  if (missing.length > 0) {
    throw new BadRequestException({
      message: `missing or empty required field(s): ${missing.join(', ')}`,
      error: 'Bad Request',
      statusCode: 400,
      fields: missing,
    });
  }
}
