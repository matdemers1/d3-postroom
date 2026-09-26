require ["imap4flags", "variables", "fileinto"];
addflag "flagvar" ["\\Deleted", "\\Answered"];
addflag "flagvar" "\\Seen";
removeflag "flagvar" "\\Deleted";
if header :contains "from" "boss@frobnitzm.example.edu" {
    setflag "bossflag" "\\Flagged";
    fileinto :flags "${bossflag}" "INBOX.From Boss";
}
fileinto :flags "${flagvar}" "Archive";
