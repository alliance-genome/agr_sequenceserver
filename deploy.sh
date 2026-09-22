#!/bin/bash

# AGR BLAST SequenceServer Deployment Script

set -e  # Exit on error

# Configuration
CONTAINER_NAME="agr-blast-prod"
IMAGE_NAME="agr-blast-prod-container"
HOST_PORT="4568"
CONTAINER_PORT="4567"
DB_PATH="/var/sequenceserver-data/blast/"
CONFIG_PATH="/var/sequenceserver-data/config/"
SEQUENCESERVER_CONFIG="/sequenceserver/public/configs/sequenceserver.conf"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Deploying AGR BLAST SequenceServer...${NC}"

# Stop and remove existing container if it exists
echo -e "${YELLOW}Stopping existing container (if any)...${NC}"
docker rm -f ${CONTAINER_NAME} 2>/dev/null || true

# Build the new image
echo -e "${YELLOW}Building Docker image...${NC}"
docker build . -t ${IMAGE_NAME} --target=minify

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Image built successfully${NC}"
else
    echo -e "${RED}✗ Image build failed${NC}"
    exit 1
fi

# Run the container in daemon mode
echo -e "${YELLOW}Starting container...${NC}"
docker run -d \
    --name ${CONTAINER_NAME} \
    --restart unless-stopped \
    -p ${HOST_PORT}:${CONTAINER_PORT} \
    -v ${DB_PATH}:/db \
    -v ${CONFIG_PATH}:/sequenceserver/public/environments \
    -e HTTPS=on \
    -e NODE_ENV="production" \
    ${IMAGE_NAME} \
    sequenceserver -c ${SEQUENCESERVER_CONFIG}

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Container started successfully${NC}"
else
    echo -e "${RED}✗ Container failed to start${NC}"
    exit 1
fi

# Wait a moment for the container to initialize
echo -e "${YELLOW}Waiting for container to initialize...${NC}"
sleep 3

# Check if container is running
if [ "$(docker ps -q -f name=${CONTAINER_NAME})" ]; then
    echo -e "${GREEN}✓ Container is running${NC}"
    echo ""
    echo -e "${GREEN}Deployment successful!${NC}"
    echo ""
    echo "Container: ${CONTAINER_NAME}"
    echo "URL: https://localhost:${HOST_PORT}"
    echo ""
    echo "Useful commands:"
    echo "  View logs:        docker logs ${CONTAINER_NAME}"
    echo "  Follow logs:      docker logs -f ${CONTAINER_NAME}"
    echo "  Restart:          docker restart ${CONTAINER_NAME}"
    echo "  Stop:             docker stop ${CONTAINER_NAME}"
    echo "  Shell access:     docker exec -it ${CONTAINER_NAME} bash"
    echo ""
else
    echo -e "${RED}✗ Container is not running. Checking logs...${NC}"
    docker logs ${CONTAINER_NAME} --tail 20
    exit 1
fi