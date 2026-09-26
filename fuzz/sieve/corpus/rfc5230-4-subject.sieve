require "vacation";
if address :matches "from" "*@ourdivision.example.com"
{
    vacation :subject "Gone fishing"
             "Having lots of fun! Back in a day or two!";
} else {
    vacation :subject "Je suis parti cette semaine"
             "Je lirai votre message quand je retourne.";
}
