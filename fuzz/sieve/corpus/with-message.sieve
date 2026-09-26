require ["fileinto", "variables", "body", "envelope"];
if header :matches "subject" "* *" { fileinto "x-${1}"; }
if body :text :contains "cheap" { discard; }
if envelope :domain :is "from" "spam.example" { discard; }
#---message---
From: a@spam.example
Subject: buy now

cheap pills
