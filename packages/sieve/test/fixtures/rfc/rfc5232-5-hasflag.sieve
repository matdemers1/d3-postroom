require ["imap4flags", "variables", "fileinto"];
set "MyVar" "NonJunk Junk gnus-forward $Forwarded NotJunk JunkRecorded $Junk $NotJunk";
if hasflag :contains "MyVar" "Junk" { fileinto "t1"; }
if hasflag :contains "MyVar" "forward" { fileinto "t2"; }
if hasflag :contains "MyVar" ["label", "forward"] { fileinto "t3"; }
if hasflag :contains "MyVar" ["junk", "forward"] { fileinto "t4"; }
if hasflag :is "MyVar" "Junk" { fileinto "t5"; }
if hasflag :is "MyVar" "forward" { fileinto "t6"; }
if hasflag :is "MyVar" ["label", "forward"] { fileinto "t7"; }
if hasflag :is "MyVar" ["junk", "forward"] { fileinto "t8"; }
