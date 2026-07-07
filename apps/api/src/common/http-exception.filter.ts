import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
}

interface MinimalResponse {
  status(code: number): MinimalResponse;
  json(body: ErrorBody): void;
}

/**
 * Global exception filter. Serializes HttpExceptions to a stable
 * {statusCode, error, message} JSON shape (matching Nest's default so existing
 * clients/tests keep working) and maps any unexpected error to a 500 WITHOUT
 * leaking its stack or message — money/secret details never reach the wire.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<MinimalResponse>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const body: ErrorBody =
        typeof payload === 'string'
          ? { statusCode: status, error: exception.name, message: payload }
          : normalize(status, payload as Record<string, unknown>);
      res.status(status).json(body);
      return;
    }

    // Unknown error: log server-side, return an opaque 500.
    this.logger.error(
      exception instanceof Error ? exception.stack ?? exception.message : String(exception),
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal Server Error',
      message: 'internal server error',
    });
  }
}

function normalize(status: number, payload: Record<string, unknown>): ErrorBody {
  return {
    statusCode: typeof payload.statusCode === 'number' ? payload.statusCode : status,
    error: typeof payload.error === 'string' ? payload.error : 'Error',
    message: (payload.message as string | string[]) ?? 'error',
  };
}
