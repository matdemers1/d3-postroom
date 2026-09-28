// SNS verification moved to @postroom/delivery/ses-feedback (PST-T-11.17), so the worker's SQS poller
// verifies exactly as POST /api/ses/sns does. Re-exported here for the api's own imports.
export * from '@postroom/delivery/ses-feedback';
