require "body";

# Don't let the base64-encoded words sneak by: :raw sees the encoding, not the words.
if body :raw :contains "MAKE MONEY FAST" {
        discard;
}
