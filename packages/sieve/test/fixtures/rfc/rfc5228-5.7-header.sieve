if header :is ["X-Caffeine"] [""] {
   discard;
}
if header :contains "X-Caffeine" "" {
   keep;
}
