# Bring back a deleted folder that git can't restore.

fixture() {
  demo_file .gitignore 'seed-data/\n'
  demo_file seed-data/users.csv 'id,name\n1,Ada\n2,Lin\n'
  demo_file seed-data/nested/orders.csv 'id,total\n1,10\n2,20\n'
}

script() {
  demo_turn "Delete seed-data, it's stale." 1
  demo_turn 'Wait, that was my only copy. Bring it back.'
}

check() {
  assert_file_has seed-data/users.csv 'id'
  assert_file_has seed-data/nested/orders.csv 'id'
  assert_cast_has "$1" 'all its contents'
}
