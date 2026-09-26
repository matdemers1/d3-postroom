require "vacation";
if header :contains ["accept-language", "content-language"] "en"
{
    vacation "I am away this week.";
} else {
    vacation "Estoy ausente esta semana.";
}
