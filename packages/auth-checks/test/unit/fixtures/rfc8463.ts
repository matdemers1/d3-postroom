// RFC 8463 Appendix A: the published keys (A.1), DNS records (A.2) and signed message (A.3).
// Transcribed from the RFC. The RSA private key of A.1 is not reproduced here: RSASSA-PKCS1-v1_5 is
// deterministic, so the published b= verifying under the published public key is the same check.

export const ED25519_SEED_B64 = 'nWGxne/9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A=';
export const ED25519_PUBLIC_B64 = '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=';

export const DNS_BRISBANE = `v=DKIM1; k=ed25519; p=${ED25519_PUBLIC_B64}`;
export const DNS_TEST =
  'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDkHlOQoBTzWR' +
  'iGs5V6NpP3idY6Wk08a5qhdR6wy5bdOKb2jLQiY/J16JYi0Qvx/byYzCNb3W91y3FutAC' +
  'DfzwQ/BC/e/8uBsCR+yz1Lxj+PL6lHvqMKrM3rG4hstT5QjvHO9PzoxZyVYLzBfO2EeC3' +
  'Ip3G+2kryOTIKT+l/K4w3QIDAQAB';

export const BODY_HASH = '2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=';

export const ED25519_SIGNATURE = [
  'DKIM-Signature: v=1; a=ed25519-sha256; c=relaxed/relaxed;',
  ' d=football.example.com; i=@football.example.com;',
  ' q=dns/txt; s=brisbane; t=1528637909; h=from : to :',
  ' subject : date : message-id : from : subject : date;',
  ' bh=2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=;',
  ' b=/gCrinpcQOoIfuHNQIbq4pgh9kyIK3AQUdt9OdqQehSwhEIug4D11Bus',
  ' Fa3bT3FY5OsU7ZbnKELq+eXdp1Q1Dw==',
].join('\r\n');

export const ED25519_B =
  '/gCrinpcQOoIfuHNQIbq4pgh9kyIK3AQUdt9OdqQehSwhEIug4D11BusFa3bT3FY5OsU7ZbnKELq+eXdp1Q1Dw==';

export const RSA_SIGNATURE = [
  'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed;',
  ' d=football.example.com; i=@football.example.com;',
  ' q=dns/txt; s=test; t=1528637909; h=from : to : subject :',
  ' date : message-id : from : subject : date;',
  ' bh=2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=;',
  ' b=F45dVWDfMbQDGHJFlXUNB2HKfbCeLRyhDXgFpEL8GwpsRe0IeIixNTe3',
  ' DhCVlUrSjV4BwcVcOF6+FF3Zo9Rpo1tFOeS9mPYQTnGdaSGsgeefOsk2Jz',
  ' dA+L10TeYt9BgDfQNZtKdN1WO//KgIqXP7OdEFE4LjFYNcUxZQ4FADY+8=',
].join('\r\n');

export const UNSIGNED = [
  'From: Joe SixPack <joe@football.example.com>',
  'To: Suzie Q <suzie@shopping.example.net>',
  'Subject: Is dinner ready?',
  'Date: Fri, 11 Jul 2003 21:00:37 -0700 (PDT)',
  'Message-ID: <20030712040037.46341.5F8J@football.example.com>',
  '',
  'Hi.',
  '',
  'We lost the game.  Are you hungry yet?',
  '',
  'Joe.',
  '',
].join('\r\n');

export const SIGNED = `${ED25519_SIGNATURE}\r\n${RSA_SIGNATURE}\r\n${UNSIGNED}`;
