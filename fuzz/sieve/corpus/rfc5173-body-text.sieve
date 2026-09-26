require ["body", "fileinto"];

# Save messages mentioning the project schedule in the
# project/schedule folder.
if body :text :contains "project schedule" {
        fileinto "project/schedule";
}
