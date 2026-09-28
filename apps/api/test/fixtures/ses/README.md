# SES event fixtures (PST-T-11.15)

Hand-made from the shapes in the Amazon SES Developer Guide ("Contents of event data that Amazon
SES publishes to Amazon SNS"): what a configuration set's SNS event destination puts in an SNS
Notification's `Message`. Synthetic addresses and ids only — no real mail. The tests wrap each in an
SNS envelope and sign it with a throwaway key made at runtime (`test/sns-signer.ts`).

`__SES_MESSAGE_ID__` and `__MESSAGE_ID__` are replaced by the test with the SES id the fake SES
answered DATA with and the original's Message-ID.
