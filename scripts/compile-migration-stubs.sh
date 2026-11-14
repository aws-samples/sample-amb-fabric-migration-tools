#!/usr/bin/env bash
#
# Compile the Go and Java copies of the migration contract.
#
# The stubs are copy-in files: docs/migration-overview.md tells the customer to
# copy one into a chaincode package they already have, so there is no build file
# beside them to run, and adding one would describe a package nobody deploys.
# This synthesizes the package the docs describe — in a temp directory, from the
# same registration snippet the docs print — and builds that. Nothing is written
# under sample/.
#
# The Node copy is not here: it needs no compiler, and test/migration-contract
# .test.ts loads and runs it against the real fabric-contract-api instead.
#
# Usage: scripts/compile-migration-stubs.sh [go|java]...   (default: both)
#
# A missing toolchain is a failure, not a skip. A gate that passes when its
# compiler is absent reports success for something it never checked.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STUBS="$ROOT/sample/chaincode/migration_contract"

# The stub imports github.com/hyperledger/fabric-contract-api-go/contractapi,
# which is the v1 line — v2 publishes the same package under /v2/contractapi.
# The version matches sample/chaincode/*/go.mod, so this compiles against the
# API the samples pin rather than a newer one the customer has not been told to
# use.
GO_CONTRACT_API='github.com/hyperledger/fabric-contract-api-go@v1.1.1'

# Every dependency fabric-chaincode-shim publishes is runtime-scoped. Gson and
# fabric-protos therefore need explicit compile dependencies: this contract uses
# Gson for JSON returns, and its paginated range query exposes
# QueryResponseMetadata from fabric-protos. See
# sample/chaincode/migration_contract/README.md.
JAVA_SHIM='2.5.5'
JAVA_PROTOS='0.3.3'
JAVA_GSON='2.14.0'
# fabric-chaincode-shim 2.5.x targets Java 11. Compile to that rather than to
# whichever JDK is installed, so the gate answers the customer's question.
JAVA_RELEASE='11'

# Templated rather than bare: macOS mktemp ignores TMPDIR without one.
BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/migration-stubs.XXXXXX")"
trap 'rm -rf "$BUILD_ROOT"' EXIT

# Runs the toolchain rather than looking it up on PATH: macOS ships java and
# javac shims that resolve and then fail for want of a runtime, so `command -v`
# answers yes to a toolchain that cannot compile anything.
require() {
  local hint="$1"
  shift
  if ! "$@" >/dev/null 2>&1; then
    echo "compile-migration-stubs: \`$*\` failed — $hint" >&2
    exit 1
  fi
}

compile_go() {
  require 'install a Go toolchain, or run this job in CI' go version

  local dir="$BUILD_ROOT/go"
  mkdir -p "$dir/migration"
  cp "$STUBS/go/migration.go" "$dir/migration/migration.go"

  # The registration from docs/migration-overview.md, compiled: NewChaincode is
  # where the contract interface is checked, so a stub that stopped satisfying
  # it fails here instead of at deploy time.
  cat > "$dir/main.go" <<'GO'
package main

import (
	"log"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"

	"compile-check/migration"
)

func main() {
	cc, err := contractapi.NewChaincode(&migration.MigrationContract{})
	if err != nil {
		log.Panicf("failed to create chaincode: %v", err)
	}
	if err := cc.Start(); err != nil {
		log.Panicf("failed to start chaincode: %v", err)
	}
}
GO

  echo "==> go: building $dir"
  (
    cd "$dir"
    go mod init compile-check >/dev/null
    go get "$GO_CONTRACT_API"
    # fabric-contract-api-go v1.1.1 does not record all dependencies needed by
    # its public packages in the generated module's go.sum. Resolve the whole
    # program before compiling, exactly as a customer package must.
    go mod tidy
    go build ./...
    go vet ./...
  )
  echo "==> go: ok"
}

compile_java() {
  require 'install a JDK, or run this job in CI' javac -version
  require 'install Maven, or run this job in CI' mvn -v

  local dir="$BUILD_ROOT/java"
  mkdir -p "$dir/src/main/java/com/ambmigration"
  cp "$STUBS/java/MigrationContract.java" \
    "$dir/src/main/java/com/ambmigration/MigrationContract.java"

  cat > "$dir/pom.xml" <<POM
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.ambmigration</groupId>
  <artifactId>compile-check</artifactId>
  <version>0</version>
  <properties>
    <maven.compiler.release>$JAVA_RELEASE</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.hyperledger.fabric-chaincode-java</groupId>
      <artifactId>fabric-chaincode-shim</artifactId>
      <version>$JAVA_SHIM</version>
    </dependency>
    <dependency>
      <groupId>org.hyperledger.fabric</groupId>
      <artifactId>fabric-protos</artifactId>
      <version>$JAVA_PROTOS</version>
    </dependency>
    <dependency>
      <groupId>com.google.code.gson</groupId>
      <artifactId>gson</artifactId>
      <version>$JAVA_GSON</version>
    </dependency>
  </dependencies>
</project>
POM

  echo "==> java: building $dir"
  (cd "$dir" && mvn -B -q compile)
  echo "==> java: ok"
}

main() {
  local languages=("$@")
  if [ ${#languages[@]} -eq 0 ]; then
    languages=(go java)
  fi

  for language in "${languages[@]}"; do
    case "$language" in
      go) compile_go ;;
      java) compile_java ;;
      *)
        echo "compile-migration-stubs: unknown language $language" >&2
        echo "usage: $0 [go|java]..." >&2
        exit 2
        ;;
    esac
  done
}

main "$@"
