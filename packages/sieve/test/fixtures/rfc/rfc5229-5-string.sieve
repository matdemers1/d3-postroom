require "variables";
set "state" "${state} pending";
if string :matches " ${state} " "* pending *" {
    # the above test always succeeds
    discard;
}
