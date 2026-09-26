# RFC 5228 §3.3: stop ends all processing; the implicit keep still applies.
if header :contains "subject" "stop here" {
   stop;
}
discard;
