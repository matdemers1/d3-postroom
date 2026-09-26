require ["vacation", "variables"];
if header :matches "subject" "*" {
    vacation :subject "Automatic response to: ${1}"
             "I'm away";
}
