# Move files into an archive, then undo a move that overwrote one.

fixture() {
  demo_file screenshots/one.png 'new\n'
  demo_file screenshots/two.png 'new\n'
  demo_file screenshots/three.png 'new\n'
  demo_file archive/2025/two.png 'old\n'
}

script() {
  demo_turn 'Move the screenshots into archive/2025.' 1
  demo_turn 'Undo that.'
  demo_human 'cat archive/2025/two.png screenshots/two.png'
}

check() {
  assert_file_has screenshots/one.png 'new'
  assert_file_has screenshots/two.png 'new'
  assert_file_has screenshots/three.png 'new'
  assert_file_has archive/2025/two.png 'old'
  assert_cast_has "$1" 'already exists'
}
