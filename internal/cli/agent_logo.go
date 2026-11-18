package cli

// dariLogo is Dari's bridge mark in Braille dots, the bridge alone without
// its circle, drawn from the logo at a size where its hangers each keep a
// column of dots.
var dariLogo = []string{
	"            ⢀⣠⣴⣾⣿⣿⣿⣿⣷⣶⣤⣀                  ",
	"          ⢀⣴⣿⣿⡿⣿⠛⠛⣿⠛⠿⣿⣿⣿⣷⣦⡀               ",
	"         ⣰⣿⣿⣿⠁ ⣿  ⣿  ⣤⡙⢿⣿⣿⣿⣦⡀             ",
	"        ⣼⣿⡟⠁⣿  ⣿  ⣿  ⣿⡇ ⠙⢿⣿⣿⣿⣦⡀           ",
	"      ⢀⣾⣿⢻⡇ ⣿  ⣿  ⣿  ⣿⡇  ⠈⢻⣿⣿⣿⣿⣆        ⣀⣀",
	"      ⣾⣿⠃⢸⡇ ⣿  ⣿  ⣿⣀⣀⣿⣇⣠⣤⣤⣤⠹⣿⣿⣿⣿⣷⣶⣾⣿⣿⣿⣿⣿⣿⣿",
	" ⣀⣀⣀⣀⣼⣿⣥⣤⣼⣷⣶⣿⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧⡹⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿",
	"    ⢰⡿⠁                      ⠸⣿⣿⣿⣿⣿⣧⡀     ",
	"   ⢀⡿⠁                        ⠹⣿⣿⣿⣿⣿⣷⡄    ",
	"   ⠜                           ⠹⣿⣿⣿⣿⣿⣿⣦   ",
}

// dariLogoSmall is dariLogo for a narrower panel.
var dariLogoSmall = []string{
	"        ⢀⣤⣶⣿⣿⣿⣿⣶⣤⣀            ",
	"      ⢀⣴⣿⡟⢹⡇ ⡇⠉⣛⢿⣿⣷⣄          ",
	"     ⢠⣾⡟⢹⡇⢸⡇ ⡇ ⣿ ⠙⢿⣿⣷⣄        ",
	"    ⢠⣿⢻⡇⢸⡇⢸⡇ ⡇ ⣿  ⣈⢻⣿⣿⣷⣤⣤⣤⣤⣤⣤⣴",
	" ⣀⣀⣠⣿⣥⣼⣧⣾⣷⣾⣷⣾⣿⣿⣿⣿⣿⣿⣧⢻⣿⣿⣿⣿⣿⣿⣿⣿⣿",
	"   ⡾⠁                ⢻⣿⣿⣿⣷⡀   ",
	"  ⠸⠁                  ⢻⣿⣿⣿⣿⣄  ",
}
