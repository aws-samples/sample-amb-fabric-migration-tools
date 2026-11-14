/**
 * Real X.509 certificates for tests that exercise creator-identity parsing.
 *
 * `cert-parser` parses creator certificates with `crypto.X509Certificate`, so a
 * hand-written PEM whose body is a DN string yields an empty common name and
 * org. These are self-signed P-256 certificates generated once with:
 *
 *   openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
 *     -nodes -keyout /dev/null -days 36500 -subj "/CN=admin/O=org1.example.com"
 *
 * They carry no private key and are valid until 2126, so nothing here expires
 * mid-suite.
 */

/** Subject `CN=admin, O=org1.example.com`. */
export const ADMIN_CERT_PEM =
  '-----BEGIN CERTIFICATE-----\n' +
  'MIIBrTCCAVOgAwIBAgIUdWGSaQdpC1X4BSRZOiI7a64JATEwCgYIKoZIzj0EAwIw\n' +
  'KzEOMAwGA1UEAwwFYWRtaW4xGTAXBgNVBAoMEG9yZzEuZXhhbXBsZS5jb20wIBcN\n' +
  'MjYwODE5MTcxNTA0WhgPMjEyNjA3MjYxNzE1MDRaMCsxDjAMBgNVBAMMBWFkbWlu\n' +
  'MRkwFwYDVQQKDBBvcmcxLmV4YW1wbGUuY29tMFkwEwYHKoZIzj0CAQYIKoZIzj0D\n' +
  'AQcDQgAEM1SbbeVphhQKoY3OXf84INy4BvqUj5M+PD3RZcVSlCqT5oNbfnavdI+S\n' +
  'pVvb0YhHO6ipe5olCOTa6VtH/5vLtaNTMFEwHQYDVR0OBBYEFCrUlmnU5eyNHTRB\n' +
  'ZL/tzxx1wKxsMB8GA1UdIwQYMBaAFCrUlmnU5eyNHTRBZL/tzxx1wKxsMA8GA1Ud\n' +
  'EwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIgJNMYqUZS7UQAVFUjOUP2Xfal\n' +
  'peL+g5EFIz7DkWKHepYCIQCjnMBpDbzh4WHrIgU0Zb8wnoof5y89bj7UKxh4cAZ1\n' +
  'rQ==\n' +
  '-----END CERTIFICATE-----\n';

/** SHA-256 over `ADMIN_CERT_PEM`'s DER bytes, as `cert-parser` reports it. */
export const ADMIN_CERT_FINGERPRINT =
  'sha256:2bbb8347557af588f316e227e2823e21cd9d49926bbc5e918c13c4f0dacd1982';

/** Subject `CN=client, O=org2.example.com`. */
export const CLIENT_CERT_PEM =
  '-----BEGIN CERTIFICATE-----\n' +
  'MIIBrzCCAVWgAwIBAgIUcayRKhNftFSCSKVWSM9Q6gKJCggwCgYIKoZIzj0EAwIw\n' +
  'LDEPMA0GA1UEAwwGY2xpZW50MRkwFwYDVQQKDBBvcmcyLmV4YW1wbGUuY29tMCAX\n' +
  'DTI2MDgxOTE3MTUwNFoYDzIxMjYwNzI2MTcxNTA0WjAsMQ8wDQYDVQQDDAZjbGll\n' +
  'bnQxGTAXBgNVBAoMEG9yZzIuZXhhbXBsZS5jb20wWTATBgcqhkjOPQIBBggqhkjO\n' +
  'PQMBBwNCAAQTRmc+CygkNxzJEF6ApICqzJ8mF7wAlD9hAG9IGocIUQvHwj8fvZ2k\n' +
  '02AebOk7lz0b9tRBp77+xoJ5HIdYNcbvo1MwUTAdBgNVHQ4EFgQUhNFgwtaW8TVm\n' +
  'efwgtc4t0wP3gT4wHwYDVR0jBBgwFoAUhNFgwtaW8TVmefwgtc4t0wP3gT4wDwYD\n' +
  'VR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEA8BV3q3WnhSv8bOcn7O4+\n' +
  'xzF1FFFslXlxzYJJ7GxTf/0CIDwgsKBtaFfbgeQiQOMPw3Y4TuRheLjFeuKnE7LR\n' +
  'H8DX\n' +
  '-----END CERTIFICATE-----\n';

/** SHA-256 over `CLIENT_CERT_PEM`'s DER bytes, as `cert-parser` reports it. */
export const CLIENT_CERT_FINGERPRINT =
  'sha256:e268f765c3778cd8b553a5c79cf412d9fa94b261fef79ef26fbda504786a1342';
