IMG ?= agent-operator:latest
AGENT_IMG ?= agent-runtime:latest

.PHONY: all build docker-build docker-push generate manifests install run

all: build

build:
	go build -o bin/manager main.go

run: build
	./bin/manager

docker-build:
	docker build -t $(IMG) .

docker-push:
	docker push $(IMG)

docker-build-agent:
	docker build -t $(AGENT_IMG) ../agent-runtime/

docker-push-agent:
	docker push $(AGENT_IMG)

# Generate CRD manifests
manifests:
	controller-gen crd rbac:roleName=agent-operator-role paths="./..." output:crd:artifacts:config=config/crd/bases

# Generate deepcopy methods
generate:
	controller-gen object paths="./..."

# Install CRDs into a cluster
install: manifests
	kubectl apply -f config/crd/bases/

# Uninstall CRDs from a cluster
uninstall:
	kubectl delete -f config/crd/bases/

# Deploy the operator to the cluster
deploy: docker-build docker-push install
	kubectl apply -f config/manager/
	kubectl apply -f config/rbac/

# Run go tests
test:
	go test ./... -coverprofile cover.out

# Lint
lint:
	golangci-lint run
