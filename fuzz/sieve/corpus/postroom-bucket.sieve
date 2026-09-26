require ["vnd.postroom.bucket", "variables"];
if header :contains "List-Unsubscribe" "" {
    bucket "newsletters";
}
if address :domain :matches "from" "*.shop.example" {
    set "b" "receipts";
    bucket "${b}";
}
