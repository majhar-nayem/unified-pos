import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

/** ETag = row version for optimistic concurrency (docs/01 §5.1 response). */
@Injectable()
export class EtagInterceptor implements NestInterceptor {
  intercept(execution: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = execution.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      tap((body) => {
        const version = (body as { version?: unknown } | null)?.version;
        if (typeof version === 'number' && Number.isInteger(version) && !res.headersSent) {
          res.setHeader('ETag', `"${version}"`);
        }
      }),
    );
  }
}
