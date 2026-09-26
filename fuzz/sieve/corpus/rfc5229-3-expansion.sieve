# RFC 5229 §3: the variable "company" holds the value "ACME".
require ["variables", "fileinto"];
set "company" "ACME";
fileinto "&%${}!";
fileinto "${doh!}";
fileinto "x${full}";
fileinto "${company}";
fileinto "${BAD${Company}";
fileinto "${President, ${Company} Inc.}";
