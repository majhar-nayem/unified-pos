import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { describe, expect, it } from 'vitest';

import { SoftwareAuthenticator, encodeCbor } from './software-authenticator.js';

const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3001';

describe('SoftwareAuthenticator (test helper) against @simplewebauthn/server', () => {
  it('encodes CBOR heads for every integer width and negative ints', () => {
    expect(encodeCbor(0)).toEqual(Buffer.from([0x00]));
    expect(encodeCbor(23)).toEqual(Buffer.from([0x17]));
    expect(encodeCbor(24)).toEqual(Buffer.from([0x18, 0x18]));
    expect(encodeCbor(256)).toEqual(Buffer.from([0x19, 0x01, 0x00]));
    expect(encodeCbor(70000)).toEqual(Buffer.from([0x1a, 0x00, 0x01, 0x11, 0x70]));
    expect(encodeCbor(-7)).toEqual(Buffer.from([0x26]));
    expect(encodeCbor('a')).toEqual(Buffer.from([0x61, 0x61]));
    expect(encodeCbor(new Map([['k', 1]]))).toEqual(Buffer.from([0xa1, 0x61, 0x6b, 0x01]));
  });

  it('completes registration and authentication; the counter advances; a stale counter is rejected by the library', async () => {
    const authenticator = new SoftwareAuthenticator({ rpId: RP_ID, origin: ORIGIN });
    const regOptions = await generateRegistrationOptions({
      rpName: 'test',
      rpID: RP_ID,
      userName: 'u',
      userID: Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
      attestationType: 'none',
    });
    const registration = await verifyRegistrationResponse({
      response: authenticator.register(regOptions) as unknown as RegistrationResponseJSON,
      expectedChallenge: regOptions.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });
    expect(registration.verified).toBe(true);
    const credential = registration.registrationInfo!.credential;
    expect(credential.id).toBe(authenticator.credentialIdBase64Url);
    expect(credential.counter).toBe(0);
    expect(credential.transports).toEqual(['internal']);
    expect(registration.registrationInfo!.fmt).toBe('none');

    const authOptions = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials: [{ id: credential.id }],
    });
    const verified = await verifyAuthenticationResponse({
      response: authenticator.assert(authOptions) as unknown as AuthenticationResponseJSON,
      expectedChallenge: authOptions.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: { id: credential.id, publicKey: credential.publicKey, counter: 0 },
    });
    expect(verified.verified).toBe(true);
    expect(verified.authenticationInfo.newCounter).toBe(1);
    expect(verified.authenticationInfo.userVerified).toBe(true);

    const replayOptions = await generateAuthenticationOptions({ rpID: RP_ID });
    await expect(
      verifyAuthenticationResponse({
        response: authenticator.assert(replayOptions, {
          counter: 1,
        }) as unknown as AuthenticationResponseJSON,
        expectedChallenge: replayOptions.challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        credential: { id: credential.id, publicKey: credential.publicKey, counter: 1 },
      }),
    ).rejects.toThrow(/counter/i);
  });
});
