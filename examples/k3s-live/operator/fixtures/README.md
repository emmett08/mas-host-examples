# Local HTTPS test credentials

`localhost-test-cert.pem` and `localhost-test-key.pem` are public, self-signed
credentials used only by the ephemeral loopback HTTPS server in
`operator/evidence.test.ts`. The key is deliberately committed test data and must
never be used for a deployed service.

The certificate covers `127.0.0.1` and `localhost` and expires in October 2046.
Tests explicitly trust this certificate while retaining TLS peer verification.
Keeping these fixtures avoids requiring the OpenSSL command-line tool in the
Node application build image.
