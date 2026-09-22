#!/bin/bash

# AGR BLAST SequenceServer Monitoring Script

CONTAINER_NAME="agr-blast-prod"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

clear

echo -e "${BLUE}==================================================${NC}"
echo -e "${BLUE}     AGR BLAST SequenceServer Monitor${NC}"
echo -e "${BLUE}==================================================${NC}"
echo ""

# Check container status
if [ "$(docker ps -q -f name=${CONTAINER_NAME})" ]; then
    echo -e "${GREEN}✓ Container Status: RUNNING${NC}"

    # Get container info
    echo ""
    echo -e "${YELLOW}Container Information:${NC}"
    docker ps --filter name=${CONTAINER_NAME} --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

    # Get resource usage
    echo ""
    echo -e "${YELLOW}Resource Usage:${NC}"
    docker stats ${CONTAINER_NAME} --no-stream --format "table {{.Container}}\t{{.CPUPerc}}\t{{.MemUsage}}"

else
    echo -e "${RED}✗ Container Status: NOT RUNNING${NC}"
fi

echo ""
echo -e "${YELLOW}Options:${NC}"
echo "1) View last 50 log lines"
echo "2) Follow logs (real-time)"
echo "3) Restart container"
echo "4) Stop container"
echo "5) Shell access"
echo "6) Check BLAST databases"
echo "7) Exit"
echo ""
read -p "Select option (1-7): " option

case $option in
    1)
        echo -e "${YELLOW}Last 50 log lines:${NC}"
        docker logs ${CONTAINER_NAME} --tail 50
        ;;
    2)
        echo -e "${YELLOW}Following logs (Ctrl+C to stop):${NC}"
        docker logs -f ${CONTAINER_NAME}
        ;;
    3)
        echo -e "${YELLOW}Restarting container...${NC}"
        docker restart ${CONTAINER_NAME}
        echo -e "${GREEN}✓ Container restarted${NC}"
        ;;
    4)
        echo -e "${YELLOW}Stopping container...${NC}"
        docker stop ${CONTAINER_NAME}
        echo -e "${GREEN}✓ Container stopped${NC}"
        ;;
    5)
        echo -e "${YELLOW}Opening shell in container...${NC}"
        docker exec -it ${CONTAINER_NAME} bash
        ;;
    6)
        echo -e "${YELLOW}BLAST Databases:${NC}"
        docker exec ${CONTAINER_NAME} ls -la /db/
        ;;
    7)
        echo -e "${GREEN}Exiting...${NC}"
        exit 0
        ;;
    *)
        echo -e "${RED}Invalid option${NC}"
        ;;
esac