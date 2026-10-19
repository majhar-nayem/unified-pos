import { SetMetadata } from '@nestjs/common';
import type { TokenKind } from '@pos/auth';

export const PUBLIC_KEY = 'kernel:public';
export const OPERATOR_ONLY_KEY = 'kernel:operatorOnly';
export const ALLOW_KINDS_KEY = 'kernel:allowKinds';

/** No authentication required (health, OpenAPI, login). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Only platform operators (tenant provisioning). Non-operators get 404. */
export const OperatorOnly = () => SetMetadata(OPERATOR_ONLY_KEY, true);

/** Token kinds accepted by this route; default is every kind except `preauth`. */
export const AllowKinds = (...kinds: TokenKind[]) => SetMetadata(ALLOW_KINDS_KEY, kinds);
