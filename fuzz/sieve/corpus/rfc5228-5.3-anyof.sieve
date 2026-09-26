if anyof (header :contains "From" "Cheney",
          header :contains "Subject" "fishing") {
   discard;
}
