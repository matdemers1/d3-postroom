require ["fileinto", "mailbox"];
fileinto :create "INBOX.folder";
if mailboxexists "Archive" { fileinto "Archive"; }
