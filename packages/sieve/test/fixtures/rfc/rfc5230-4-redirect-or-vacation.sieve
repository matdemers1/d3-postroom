require "vacation";
if header :contains "from" "boss@example.edu" {
    redirect "pleeb@isp.example.org";
} else {
    vacation "Sorry, I'm away, I'll read your
message when I get around to it.";
}
