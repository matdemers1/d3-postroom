#
# Example Sieve Filter
# Declare any optional features or extensions used by the script
#
require ["fileinto", "imap4flags"];

#
# Move all messages from the boss to the "From Boss" mailbox and
# flag them
#
if header :contains "from" "boss@frobnitzm.example.edu" {
    setflag "\\Flagged";
    fileinto "From Boss";
}

#
# Move messages from a mailing list to its own mailbox and mark them
# as read, but keep them flagged if they mention the project
#
if header :contains "subject" "[acme-users]" {
    addflag "\\Seen";
    if header :contains "subject" "Project X" {
        addflag "\\Flagged";
    }
    fileinto "Lists";
    removeflag "\\Seen";
}

#
# Anything else that is left to the implicit keep carries whatever
# flags the internal variable holds at the end
#
