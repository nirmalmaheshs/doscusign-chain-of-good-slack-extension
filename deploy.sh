#!/bin/bash

# Configuration
AWS_REGION="us-east-1"
ECR_REPOSITORY_NAME="docusign-app-extension"
ECS_CLUSTER_NAME="docusign-slack-extension-cluster"
ECS_SERVICE_NAME="docusign-slack-extension-service"

# Get AWS account ID
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query "Account" --output text)
ECR_REPOSITORY_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY_NAME}"

# Create ECR repository if it doesn't exist
if ! aws ecr describe-repositories --repository-names ${ECR_REPOSITORY_NAME} 2>/dev/null; then
    echo "Creating ECR repository ${ECR_REPOSITORY_NAME}..."
    aws ecr create-repository --repository-name ${ECR_REPOSITORY_NAME}
fi

# Login to ECR
echo "Logging in to ECR..."
aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${ECR_REPOSITORY_URI}

# Build Docker image with platform specification
echo "Building Docker image..."
docker build --platform linux/amd64 -t ${ECR_REPOSITORY_NAME} .

# Tag image
IMAGE_TAG=$(date +%Y%m%d-%H%M%S)
docker tag ${ECR_REPOSITORY_NAME}:latest ${ECR_REPOSITORY_URI}:${IMAGE_TAG}
docker tag ${ECR_REPOSITORY_NAME}:latest ${ECR_REPOSITORY_URI}:latest

# Push images to ECR
echo "Pushing images to ECR..."
docker push ${ECR_REPOSITORY_URI}:${IMAGE_TAG}
docker push ${ECR_REPOSITORY_URI}:latest

# Update ECS service
echo "Updating ECS service..."

# Get current task definition
TASK_DEFINITION=$(aws ecs describe-task-definition \
    --task-definition $(aws ecs describe-services \
        --cluster ${ECS_CLUSTER_NAME} \
        --services ${ECS_SERVICE_NAME} \
        --query 'services[0].taskDefinition' \
        --output text))

# Create new task definition
NEW_TASK_DEFINITION=$(echo $TASK_DEFINITION | jq --arg IMAGE "${ECR_REPOSITORY_URI}:${IMAGE_TAG}" \
    '.taskDefinition | .containerDefinitions[0].image = $IMAGE | del(.taskDefinitionArn) | del(.revision) | del(.status) | del(.requiresAttributes) | del(.compatibilities) | del(.registeredAt) | del(.registeredBy)')

# Register new task definition
NEW_TASK_DEFINITION_ARN=$(aws ecs register-task-definition \
    --cli-input-json "$NEW_TASK_DEFINITION" \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text)

# Update service with new task definition
aws ecs update-service \
    --cluster ${ECS_CLUSTER_NAME} \
    --service ${ECS_SERVICE_NAME} \
    --task-definition ${NEW_TASK_DEFINITION_ARN} \
    --force-new-deployment

echo "Deployment completed successfully!"
echo "Image tag: ${IMAGE_TAG}"
echo "Task definition ARN: ${NEW_TASK_DEFINITION_ARN}"