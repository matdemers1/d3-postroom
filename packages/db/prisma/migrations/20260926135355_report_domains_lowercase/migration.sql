-- PST-T-7.2: domain names are case-insensitive (RFC 4343). Reports are now stored lowercased; bring
-- any row stored before that into line so the 14-day streak sees it.
UPDATE "dmarc_report" SET "domain" = lower("domain") WHERE "domain" <> lower("domain");
UPDATE "tlsrpt_policy" SET "policy_domain" = lower("policy_domain") WHERE "policy_domain" <> lower("policy_domain");
