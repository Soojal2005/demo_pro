import { HttpStatus, Type, applyDecorators } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiExtraModels,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';

/**
 * The one envelope shape every response actually has at runtime — see
 * src/common/utils.ts. Swagger only ever sees a handler's bare return type,
 * because ResponseInterceptor adds the envelope *after* the fact, so these
 * decorators are the only way the published OpenAPI schema matches what the
 * client actually receives. Per API_CONVENTIONS.md, never use Swagger's own
 * @ApiOkResponse/@ApiCreatedResponse with a bare `type:` for an endpoint —
 * it documents a shape the API never sends.
 *
 * Minimal local shape rather than importing @nestjs/swagger's own
 * SchemaObject: that type lives at a deep import path the package's
 * `exports` map doesn't expose, so nodenext module resolution can't reach
 * it. Every decorator below that accepts `schema:` structurally accepts
 * this instead.
 */
interface JsonSchema {
  type?: string;
  format?: string;
  nullable?: boolean;
  $ref?: string;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
}

const BASE_ENVELOPE_PROPERTIES: Record<string, JsonSchema> = {
  success: { type: 'boolean' },
  statusCode: { type: 'number' },
  message: { type: 'string' },
  timestamp: { type: 'string', format: 'date-time' },
  path: { type: 'string' },
};

function envelopeSchema(dataSchema: JsonSchema): JsonSchema {
  return {
    type: 'object',
    properties: {
      ...BASE_ENVELOPE_PROPERTIES,
      data: dataSchema,
    },
  };
}

function dataSchemaFor(
  dto: Type<unknown> | undefined,
  isArray: boolean,
): JsonSchema {
  if (!dto) return { type: 'null', nullable: true };
  const ref: JsonSchema = { $ref: getSchemaPath(dto) };
  return isArray ? { type: 'array', items: ref } : ref;
}

interface EnvelopeOptions {
  isArray?: boolean;
}

/** 200 OK, enveloped. Omit `dto` for an endpoint whose data is always null. */
export function ApiOkEnvelope(
  dto?: Type<unknown>,
  options: EnvelopeOptions = {},
): MethodDecorator {
  return applyDecorators(
    ...(dto ? [ApiExtraModels(dto)] : []),
    ApiOkResponse({
      schema: envelopeSchema(dataSchemaFor(dto, options.isArray ?? false)),
    }),
  );
}

/** 201 Created, enveloped. */
export function ApiCreatedEnvelope(
  dto?: Type<unknown>,
  options: EnvelopeOptions = {},
): MethodDecorator {
  return applyDecorators(
    ...(dto ? [ApiExtraModels(dto)] : []),
    ApiCreatedResponse({
      schema: envelopeSchema(dataSchemaFor(dto, options.isArray ?? false)),
    }),
  );
}

/** 202 Accepted, enveloped. Use for work that has been durably queued. */
export function ApiAcceptedEnvelope(
  dto?: Type<unknown>,
  options: EnvelopeOptions = {},
): MethodDecorator {
  return applyDecorators(
    ...(dto ? [ApiExtraModels(dto)] : []),
    ApiResponse({
      status: HttpStatus.ACCEPTED,
      schema: envelopeSchema(dataSchemaFor(dto, options.isArray ?? false)),
    }),
  );
}

/** 204 No Content. The HTTP specification suppresses the response envelope. */
export function ApiNoContentEnvelope(): MethodDecorator {
  return applyDecorators(ApiNoContentResponse({ description: 'No content' }));
}

const STATUS_DESCRIPTIONS: Partial<Record<HttpStatus, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Validation failed',
  [HttpStatus.UNAUTHORIZED]: 'Missing or invalid credentials',
  [HttpStatus.FORBIDDEN]: 'Not permitted',
  [HttpStatus.NOT_FOUND]: 'Not found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable',
  [HttpStatus.NOT_IMPLEMENTED]: 'Not implemented',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal server error',
};

/**
 * Every failure in this API has the same shape — this takes only statuses,
 * never a type. List the ones an endpoint can *actually* return; a
 * frontend that has to guess will handle the wrong ones.
 */
export function ApiErrorEnvelope(...statuses: HttpStatus[]): MethodDecorator {
  const errorSchema = envelopeSchema({ type: 'null', nullable: true });
  return applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: STATUS_DESCRIPTIONS[status] ?? 'Error',
        schema: errorSchema,
      }),
    ),
  );
}
