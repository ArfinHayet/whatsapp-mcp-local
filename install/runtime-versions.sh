# Official release archives and their published SHA-256 checksums.
NODE_VERSION=26.13.0
GO_VERSION=1.27.3
case "$(/usr/bin/uname -m)" in
  arm64)
    NODE_ARCH=arm64
    NODE_SHA=d38bd5e5a2ddce6bbb5ce45e46e208337da4d51fffe611e567fd32073d6439f6
    GO_ARCH=arm64
    GO_SHA=dd3908cf20959d798c1e06ebe5b72213f0505ce01373b40ce3110975a6cd99c2
    ;;
  x86_64)
    NODE_ARCH=x64
    NODE_SHA=525c9b29bb0263d687de60a4cec0e2a6db876a8eb032369e5795eca71e7c358e
    GO_ARCH=amd64
    GO_SHA=b6f8e931e4ab497fcde6da8ae4499a58f9d258e55c8a80824a516eae5950a750
    ;;
  *) echo 'Unsupported Mac architecture.' >&2; exit 1 ;;
esac
